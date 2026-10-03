import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {ToolHost} from '../src/tools/host.js';

let root: string;
let host: ToolHost;
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_CLAUDE_SETTINGS = path.join(process.env.REIN_HOME, 'none.json');
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-mono-')));
  mkdirSync(path.join(root, 'packages/billing/src'), {recursive: true});
  mkdirSync(path.join(root, 'packages/web'), {recursive: true});
  writeFileSync(path.join(root, 'AGENTS.md'), 'root rules (already in the system prompt)');
  writeFileSync(path.join(root, 'packages/billing/AGENTS.md'), 'Money is integer cents.');
  writeFileSync(path.join(root, 'packages/billing/src/CLAUDE.md'), 'Prefix functions with billing_.');
  writeFileSync(path.join(root, 'packages/billing/src/pay.ts'), 'export {};\n');
  writeFileSync(path.join(root, 'packages/web/page.ts'), 'export {};\n');
  host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
});

describe('scoped subfolder instructions', () => {
  it('arrive with the first tool call in their folder, labeled with their scope, once', async () => {
    const first = await host.call('read', {path: 'packages/billing/src/pay.ts'});
    expect(first.text).toContain('<scoped_instructions file="packages/billing/AGENTS.md" applies_to="packages/billing/">');
    expect(first.text).toContain('apply ONLY to files under packages/billing/');
    expect(first.text).toContain('Money is integer cents.');
    expect(first.text).toContain('applies_to="packages/billing/src/"');
    expect(first.text).not.toContain('root rules');
    const again = await host.call('read', {path: 'packages/billing/src/pay.ts'});
    expect(again.text).not.toContain('scoped_instructions');
    host.close();
  });

  it('other folders get none; a new conversation gets them again', async () => {
    expect((await host.call('read', {path: 'packages/web/page.ts'})).text).not.toContain('scoped_instructions');
    await host.call('list', {path: 'packages/billing'});
    host.deliveredInstructions.clear();
    expect((await host.call('read', {path: 'packages/billing/src/pay.ts'})).text).toContain('Money is integer cents.');
    host.close();
  });
});
