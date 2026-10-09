import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../src/build/affected.js', async (orig) => ({
  ...(await orig<object>()),
  changedFiles: async () => ['libs/auth/session.ts'],
  affected: async () => ({system: 'nx', targets: ['api', 'web'], test: 'nx run-many -t test -p api,web'}),
}));
const {Runtime} = await import('../src/runtime.js');

/** What stopHook reads for verify-affected: config, changed files, and a shell tool with a canned result. */
function runtime(experiments: string[], result: {ok: boolean; text: string}) {
  const r = Object.create(Runtime.prototype);
  const commands: string[] = [];
  r.config = {experiments: ['-verify-requirements', ...experiments], shellMaxMinutes: 120};
  r.engine = {transcript: {id: 't', messages: [{role: 'user', text: 'Fix the session bug'}]}};
  r.checkpoints = {changedSince: () => ['libs/auth/session.ts']};
  r.snapshots = {changedSince: async () => []};
  r.currentTurn = () => 0;
  r.lsp = {turnEnd: async () => undefined};
  r.tools = {call: async (_name: string, args: {command: string}) => (commands.push(args.command), result)};
  r.keptGoing = 0;
  return {r: r as InstanceType<typeof Runtime>, commands};
}

const cwd = process.cwd();
beforeEach(() => process.chdir(mkdtempSync(path.join(os.tmpdir(), 'rein-va-'))));
afterEach(() => process.chdir(cwd));

describe('verify-affected', () => {
  it("runs the affected tests once per request and sends the agent back when they fail", async () => {
    const {r, commands} = runtime(['verify-affected'], {ok: false, text: '[exit 1]\nFAIL  apps/api/test/session.test.ts\nError: expected expired at libs/auth/session.ts:12'});
    const stop = await r.stopHook(false);
    expect(commands).toEqual(['nx run-many -t test -p api,web']);
    expect(stop?.reason).toMatch(/^The tests for what this request changed failed \(nx: api, web; `nx run-many -t test -p api,web`\)/);
    expect(stop?.reason).toMatch(/libs\/auth\/session\.ts:12/);
    expect(await r.stopHook(true)).toBeUndefined(); // once per request
  });

  it('says nothing when they pass, and is off unless listed', async () => {
    expect(await runtime(['verify-affected'], {ok: true, text: 'all passed'}).r.stopHook(false)).toBeUndefined();
    const off = runtime([], {ok: false, text: 'x'});
    expect(await off.r.stopHook(false)).toBeUndefined();
    expect(off.commands).toEqual([]);
  });
});
