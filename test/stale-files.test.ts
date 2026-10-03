import {mkdtempSync, realpathSync, utimesSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {ToolHost} from '../src/tools/host.js';

let root: string;
let host: ToolHost;
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_CLAUDE_SETTINGS = path.join(process.env.REIN_HOME, 'none.json');
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-stale-')));
  writeFileSync(path.join(root, 'a.ts'), 'const a = 1;\n');
  host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', scratch: () => path.join(root, '.scratch')});
});

describe('stale-file protection', () => {
  it('editing or overwriting an existing file needs a read first', async () => {
    expect((await host.call('edit', {path: 'a.ts', old_string: '1', new_string: '2'})).text).toMatch(/read a\.ts before changing it/);
    expect((await host.call('write', {path: 'a.ts', content: 'x'})).text).toMatch(/read a\.ts before changing it/);
    expect((await host.call('write', {path: 'new.ts', content: 'fresh'})).ok).toBe(true); // new files are fine
    await host.call('read', {path: 'a.ts'});
    expect((await host.call('edit', {path: 'a.ts', old_string: '1', new_string: '2'})).ok).toBe(true);
    expect((await host.call('edit', {path: 'a.ts', old_string: '2', new_string: '3'})).ok).toBe(true); // its own edit keeps it fresh
    host.close();
  });

  it('a file changed since it was read must be read again', async () => {
    await host.call('read', {path: 'a.ts'});
    writeFileSync(path.join(root, 'a.ts'), 'const a = 100; // a teammate\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(path.join(root, 'a.ts'), later, later);
    const res = await host.call('edit', {path: 'a.ts', old_string: '100', new_string: '2'});
    expect(res.text).toMatch(/changed since you last read it/);
    await host.call('read', {path: 'a.ts'});
    expect((await host.call('edit', {path: 'a.ts', old_string: '100', new_string: '2'})).ok).toBe(true);
    host.close();
  });

  it('the scratchpad is exempt; a new conversation starts with nothing read', async () => {
    writeFileSync(path.join(root, 'b.ts'), 'b');
    await host.call('write', {path: path.join(root, '.scratch/notes.md'), content: 'one'});
    expect((await host.call('write', {path: path.join(root, '.scratch/notes.md'), content: 'two'})).ok).toBe(true);
    await host.call('read', {path: 'b.ts'});
    host.reads.clear(); // what the runtime does on /clear and /resume
    expect((await host.call('write', {path: 'b.ts', content: 'c'})).text).toMatch(/before changing it/);
    host.close();
  });
});
