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

describe('experiments', () => {
  it('reread-unchanged: a repeat whole-file read in the same model context is a one-line note', async () => {
    let context = 'claude:sonnet#1#0';
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => ['reread-unchanged'], contextId: () => context});
    expect((await host.call('read', {path: 'src/a.ts'})).text).toContain('export const total');
    const again = await host.call('read', {path: 'src/a.ts'});
    expect(again.text).toMatch(/unchanged since you read it earlier/);
    expect((await host.call('read', {path: 'src/a.ts', offset: 1, limit: 1})).text).toContain('export const total'); // a range is always read
    await host.call('edit', {path: 'src/a.ts', old_string: 'total', new_string: 'sum'});
    expect((await host.call('read', {path: 'src/a.ts'})).text).toContain('export const sum'); // changed: read again
    context = 'claude:sonnet#2#0'; // compaction, failover, a model switch: the earlier read is gone
    expect((await host.call('read', {path: 'src/a.ts'})).text).toContain('export const sum');
    host.close();
  });

  it('reread-unchanged is off unless asked for', async () => {
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', contextId: () => 'x'});
    await host.call('read', {path: 'src/a.ts'});
    expect((await host.call('read', {path: 'src/a.ts'})).text).toContain('export const total');
    host.close();
  });

  it('quiet-passing-output: a passing build or test keeps its last lines; failures stay whole', async () => {
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => ['quiet-passing-output']});
    const many = `node -e "for (let i = 0; i < 100; i++) console.log('ok ' + i)"`;
    const pass = await host.call('shell', {command: `${many}; echo npm test`});
    expect(pass.text).toMatch(/^\[exit 0 after [^\]]*\]\n\(passed: \d+ earlier lines of output left out/);
    expect(pass.text).toContain('ok 99');
    expect(pass.text).not.toContain('ok 10\n');
    const fail = await host.call('shell', {command: `${many}; echo npm test; exit 1`});
    expect(fail.text).toContain('ok 10\n');
    const other = await host.call('shell', {command: many}); // not a build or test: untouched
    expect(other.text).toContain('ok 10\n');
    host.close();
  });

  it('todo-piggyback: edit, write and shell carry the task list, applied without a separate call', async () => {
    const lists: unknown[] = [];
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => ['todo-piggyback']});
    host.register({name: 'todo_write', label: 'Tasks', description: '', inputSchema: {type: 'object'}, mutating: false, summarize: () => '', run: async (_c, a) => (lists.push(a.todos), {ok: true, text: 'ok'})});
    const edit = host.specs().find((t) => t.name === 'edit')!;
    expect((edit.inputSchema as any).properties.todos.type).toBe('array');
    await host.call('read', {path: 'src/a.ts'});
    const todos = [{content: 'Rename total', status: 'completed'}];
    const r = await host.call('edit', {path: 'src/a.ts', old_string: 'total', new_string: 'sum', todos});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('(task list updated)');
    expect(lists).toEqual([todos]);
    expect(file('src/a.ts')).toContain('sum'); // the edit itself ran normally
    host.close();
    const off = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    off.register({name: 'todo_write', label: 'Tasks', description: '', inputSchema: {type: 'object'}, mutating: false, summarize: () => '', run: async () => ({ok: true, text: 'ok'})});
    expect((off.specs().find((t) => t.name === 'edit')!.inputSchema as any).properties.todos).toBeUndefined();
    off.close();
  });

  it('lazy-tools: rarely needed tools leave the list and are reached through tool', async () => {
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => ['lazy-tools']});
    host.register({name: 'web_search', label: 'WebSearch', description: 'Search the web. Returns results.', inputSchema: {type: 'object', properties: {query: {type: 'string'}}}, mutating: false, summarize: () => '', run: async (_c, a) => ({ok: true, text: `results for ${a.query}`})});
    const names = host.specs().map((t) => t.name);
    expect(names).toContain('read');
    expect(names).not.toContain('web_search');
    const index = host.specs().find((t) => t.name === 'tool')!;
    expect(index.description).toContain('web_search: Search the web.');
    expect((await host.call('tool', {name: 'web_search'})).text).toContain('"query"'); // its parameters
    expect((await host.call('tool', {name: 'web_search', args: {query: 'rein'}})).text).toBe('results for rein');
    expect((await host.call('tool', {name: 'nope'})).ok).toBe(false);
    host.close();
    const off = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    off.register({name: 'web_search', label: 'WebSearch', description: 'x', inputSchema: {type: 'object'}, mutating: false, summarize: () => '', run: async () => ({ok: true, text: ''})});
    expect(off.specs().map((t) => t.name)).toContain('web_search');
    expect(off.specs().map((t) => t.name)).not.toContain('tool');
    off.close();
  });
});


describe('outline-reads', () => {
  const long = () => {
    const body = Array.from({length: 600}, (_, i) => (i % 100 === 0 ? `export function f${i}(x: number) {\n  const y = x;\n  return y;\n}` : `// line ${i}`)).join('\n');
    writeFileSync(path.join(root, 'src/long.ts'), body + '\n');
  };

  it('a long file read whole comes back as an outline with line numbers; ranges and full: true read the text', async () => {
    long();
    const on = {...ctx, outlineReads: true};
    const outline = await readTool(on, {path: 'src/long.ts'});
    expect(outline.text).toMatch(/src\/long\.ts has \d+ lines .* outline/);
    expect(outline.text).toMatch(/export function f100\(x: number\)/);
    expect(outline.text).not.toMatch(/const y|\/\/ line/); // a function's insides and comments are left out
    expect((await readTool(on, {path: 'src/long.ts', offset: 1, limit: 3})).text).toMatch(/const y = x/);
    expect((await readTool(on, {path: 'src/long.ts', full: true})).text).toMatch(/\/\/ line 1\n/);
    expect((await readTool(ctx, {path: 'src/long.ts'})).text).toMatch(/\/\/ line 1\n/); // off unless listed
    expect((await readTool(on, {path: 'src/a.ts'})).text).toMatch(/export const total = 1/); // short files read whole
  });
});
