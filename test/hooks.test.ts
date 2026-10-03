import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {runHooks} from '../src/hooks.js';
import {ToolHost, type ApprovalRequest} from '../src/tools/host.js';

let root: string;
const settings = (hooks: object, where = '.rein/settings.json') => {
  mkdirSync(path.dirname(path.join(root, where)), {recursive: true});
  writeFileSync(path.join(root, where), JSON.stringify({hooks}));
};
const cmd = (command: string) => [{hooks: [{type: 'command', command}]}];
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_CLAUDE_SETTINGS = path.join(process.env.REIN_HOME, 'none.json');
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-hooks-')));
});

describe('hooks', () => {
  it('PreToolUse exit 2 blocks the tool; stderr goes to the model (Claude Code matcher names work)', async () => {
    settings({PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'echo "no curl here" >&2; exit 2'}]}]}, '.claude/settings.json');
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    const res = await host.call('shell', {command: 'echo hi'});
    expect(res.ok).toBe(false);
    expect(res.text).toContain('blocked by a PreToolUse hook: no curl here');
    host.close();
  });

  it('PreToolUse gets the call as JSON on stdin; "allow" skips the prompt, "deny" blocks', async () => {
    const log = path.join(root, 'seen.json');
    settings({PreToolUse: [{matcher: 'write', hooks: [{type: 'command', command: `cat > ${log}; echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`}]}]});
    const asked: ApprovalRequest[] = [];
    const host = new ToolHost({root, mode: () => 'ask', approve: async (r) => (asked.push(r), 'deny')});
    const res = await host.call('write', {path: 'a.txt', content: 'x'});
    expect(res.ok).toBe(true);
    expect(asked).toHaveLength(0);
    const seen = JSON.parse(readFileSync(log, 'utf8'));
    expect(seen).toMatchObject({hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: {path: 'a.txt'}});
    settings({PreToolUse: [{matcher: '*', hooks: [{type: 'command', command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"frozen"}}'`}]}]});
    expect((await host.call('write', {path: 'b.txt', content: 'x'})).text).toContain('frozen');
    host.close();
  });

  it('PostToolUse feedback is appended to the result the model sees', async () => {
    settings({PostToolUse: cmd('echo "lint: missing semicolon" >&2; exit 2')});
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    const res = await host.call('write', {path: 'a.ts', content: 'const a = 1'});
    expect(res.ok).toBe(true);
    expect(res.text).toContain('[PostToolUse hook] lint: missing semicolon');
    host.close();
  });

  it('UserPromptSubmit: exit 2 blocks, stdout adds context; other failures are reported, not blocking', async () => {
    settings({UserPromptSubmit: cmd('echo "branch: main"')});
    expect(await runHooks('UserPromptSubmit', root, {prompt: 'hi'})).toMatchObject({context: 'branch: main'});
    settings({UserPromptSubmit: cmd('echo "no secrets please" >&2; exit 2')});
    expect((await runHooks('UserPromptSubmit', root, {prompt: 'hi'})).block).toBe('no secrets please');
    settings({UserPromptSubmit: cmd('exit 1')});
    const r = await runHooks('UserPromptSubmit', root, {prompt: 'hi'});
    expect(r.block).toBeUndefined();
    expect(r.errors[0]).toMatch(/exit 1/);
  });

  it('Stop: decision "block" asks the agent to continue', async () => {
    settings({Stop: cmd(`echo '{"decision":"block","reason":"tests are still failing"}'`)});
    expect((await runHooks('Stop', root, {stop_hook_active: false})).block).toBe('tests are still failing');
  });
});
