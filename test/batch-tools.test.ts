import {mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {editTool, readManyTool, readTool, type ToolContext} from '../src/tools/fs.js';
import {Checkpoints} from '../src/session/checkpoints.js';
import {ToolHost} from '../src/tools/host.js';

let root: string;
let ctx: ToolContext;
const file = (p: string) => readFileSync(path.join(root, p), 'utf8');
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_CLAUDE_SETTINGS = path.join(process.env.REIN_HOME, 'none.json');
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-proj-')));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/a.ts'), 'export const total = 1;\nexport const name = "a";\n');
  writeFileSync(path.join(root, 'src/b.ts'), 'import {total} from "./a";\nconsole.log(total);\n');
  ctx = {root, reads: new Map()};
});

describe('several edits in one call', () => {
  it('apply in order across files', async () => {
    await readManyTool(ctx, {paths: ['src/a.ts', 'src/b.ts']});
    const r = await editTool(ctx, {
      path: 'src/a.ts',
      edits: [
        {old_string: 'total', new_string: 'sum'}, // defaults to the top-level path
        {old_string: 'export const sum', new_string: 'export const grandSum'}, // sees the edit before it
        {path: 'src/b.ts', old_string: 'total', new_string: 'grandSum', replace_all: true},
      ],
    } as any);
    expect(r.text).toBe('Edited 2 files: src/a.ts (2 replacements), src/b.ts (2 replacements)');
    expect(file('src/a.ts')).toContain('export const grandSum = 1;');
    expect(file('src/b.ts')).toBe('import {grandSum} from "./a";\nconsole.log(grandSum);\n');
    expect(r.diff?.filter((d) => d.kind === 'note').map((d) => d.text)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('write nothing when any edit fails, and say which', async () => {
    await readManyTool(ctx, {paths: ['src/a.ts', 'src/b.ts']});
    await expect(editTool(ctx, {edits: [{path: 'src/a.ts', old_string: 'total', new_string: 'sum'}, {path: 'src/b.ts', old_string: 'missing', new_string: 'x'}]} as any)).rejects.toThrow(/edits\[1\]: old_string not found in src\/b.ts/);
    expect(file('src/a.ts')).toContain('total'); // the first edit wasn't written either
  });

  it('keep the read-before-edit rule for every file', async () => {
    await readTool(ctx, {path: 'src/a.ts'});
    await expect(editTool(ctx, {edits: [{path: 'src/a.ts', old_string: 'total', new_string: 'sum'}, {path: 'src/b.ts', old_string: 'total', new_string: 'sum'}]} as any)).rejects.toThrow(/read src\/b.ts before changing it/);
    expect(file('src/a.ts')).toContain('total');
  });

  it('go through the host as one approval, checkpointing every file', async () => {
    const sessionId = `s${Math.random().toString(36).slice(2)}`;
    const cp = new Checkpoints(() => sessionId);
    let previews = 0;
    const host = new ToolHost({root, mode: () => 'ask', approve: async (req) => (previews++, expect(req.preview).toContain('src/b.ts'), 'once'), checkpoint: (f) => cp.snapshot(1, f)});
    await host.call('read', {paths: ['src/a.ts', 'src/b.ts']});
    const r = await host.call('edit', {edits: [{path: 'src/a.ts', old_string: 'total', new_string: 'sum'}, {path: 'src/b.ts', old_string: 'total', new_string: 'sum', replace_all: true}]});
    expect(r.ok).toBe(true);
    expect(previews).toBe(1);
    cp.restore(1);
    expect(file('src/a.ts')).toContain('total');
    expect(file('src/b.ts')).toContain('total');
    host.close();
  });

  it('are blocked by a deny rule on any file in the batch', async () => {
    mkdirSync(path.join(root, '.rein'));
    writeFileSync(path.join(root, '.rein', 'settings.json'), JSON.stringify({permissions: {deny: ['Edit(src/b.ts)']}}));
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    await host.call('read', {paths: ['src/a.ts', 'src/b.ts']});
    const r = await host.call('edit', {path: 'src/a.ts', edits: [{old_string: 'total', new_string: 'sum'}, {path: 'src/b.ts', old_string: 'total', new_string: 'sum'}]});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/permission rule/);
    expect(file('src/a.ts')).toContain('total');
    host.close();
  });
});

describe('batching nudges', () => {
  it('point out edits / paths on the second single call in a row, once per session', async () => {
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    const first = await host.call('read', {path: 'src/a.ts'});
    expect(first.text).not.toContain('paths');
    const second = await host.call('read', {path: 'src/b.ts'});
    expect(second.text).toContain('Pass them all as `paths` in one read call');
    expect((await host.call('read', {path: 'src/a.ts'})).text).not.toContain('`paths`'); // once
    const e1 = await host.call('edit', {path: 'src/a.ts', old_string: 'total', new_string: 'sum'});
    expect(e1.text).not.toContain('`edits`');
    const e2 = await host.call('edit', {path: 'src/b.ts', old_string: 'total', new_string: 'sum', replace_all: true});
    expect(e2.text).toContain('Pass them all as `edits` in one edit call');
    host.close();
  });

  it('say nothing to a model that already batches', async () => {
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    await host.call('read', {paths: ['src/a.ts', 'src/b.ts']});
    const r = await host.call('edit', {edits: [{path: 'src/a.ts', old_string: 'total', new_string: 'sum'}, {path: 'src/b.ts', old_string: 'total', new_string: 'sum', replace_all: true}]});
    expect(r.text).not.toContain('round trip');
    host.close();
  });
});

describe('several files in one read', () => {
  it('returns each under its path, with failures in place', async () => {
    const r = await readManyTool(ctx, {paths: ['src/a.ts', 'src/missing.ts', 'src/b.ts']});
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^==> src\/a.ts <==\n {5}1\texport const total = 1;/);
    expect(r.text).toContain('==> src/missing.ts <==\nerror: src/missing.ts does not exist');
    expect(r.text).toContain('==> src/b.ts <==\n     1\timport {total} from "./a";');
    await expect(readManyTool(ctx, {paths: Array.from({length: 21}, (_, i) => `f${i}`)})).rejects.toThrow(/at most 20/);
  });
});
