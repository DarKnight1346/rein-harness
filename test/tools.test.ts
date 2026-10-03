import {mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {deleteTool, editTool, globToRegExp, readTool, searchTool, writeTool, type ToolContext} from '../src/tools/fs.js';

let ctx: ToolContext;
beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rein-proj-'));
  ctx = {root};
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.ts'), 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n');
});

describe('path confinement', () => {
  it('rejects paths and symlinks that escape the project', async () => {
    await expect(readTool(ctx, {path: '../etc/passwd'})).rejects.toThrow(/outside the project/);
    await expect(writeTool(ctx, {path: '/tmp/rein-escape.txt', content: 'x'})).rejects.toThrow(/outside the project/);
    await symlink(os.tmpdir(), path.join(ctx.root, 'link'));
    await expect(writeTool(ctx, {path: 'link/escape.txt', content: 'x'})).rejects.toThrow(/outside the project/);
    await expect(deleteTool(ctx, {path: '.'})).rejects.toThrow(/project root/);
  });
});

describe('read', () => {
  it('numbers lines cat -n style and pages with offset/limit', async () => {
    const r = await readTool(ctx, {path: 'src/a.ts'});
    expect(r.text.split('\n')[0]).toBe('     1\tconst a = 1;');
    const p = await readTool(ctx, {path: 'src/a.ts', offset: 2, limit: 1});
    expect(p.text).toMatch(/^     2\tconst b = 2;\n… more lines follow \(use offset=3; file is \d+ B\)$/);
    expect((await readTool(ctx, {path: 'src'})).text).toContain('a.ts');
  });
});

describe('write / edit / delete', () => {
  it('creates files with parents', async () => {
    const r = await writeTool(ctx, {path: 'new/dir/x.txt', content: 'hi\nthere\n'});
    expect(r.text).toBe('Created new/dir/x.txt (2 lines)');
    expect(await readFile(path.join(ctx.root, 'new/dir/x.txt'), 'utf8')).toBe('hi\nthere\n');
  });
  it('edits a unique match and refuses ambiguous ones', async () => {
    await expect(editTool(ctx, {path: 'src/a.ts', old_string: '= 1;', new_string: '= 9;'})).rejects.toThrow(/matches 2 places/);
    await expect(editTool(ctx, {path: 'src/a.ts', old_string: 'nope', new_string: 'x'})).rejects.toThrow(/not found/);
    const r = await editTool(ctx, {path: 'src/a.ts', old_string: 'const b = 2;', new_string: 'const b = 3;'});
    expect(r.text).toBe('Edited src/a.ts: 1 replacement at line 2');
    const all = await editTool(ctx, {path: 'src/a.ts', old_string: '= 1;', new_string: '= 9;', replace_all: true});
    expect(all.text).toContain('2 replacements');
    expect(await readFile(path.join(ctx.root, 'src/a.ts'), 'utf8')).toBe('const a = 9;\nconst b = 3;\nconst a2 = 9;\n');
  });
  it('deletes files and guards non-empty directories', async () => {
    await expect(deleteTool(ctx, {path: 'src'})).rejects.toThrow(/non-empty/);
    await deleteTool(ctx, {path: 'src/a.ts'});
    expect(existsSync(path.join(ctx.root, 'src/a.ts'))).toBe(false);
    await deleteTool(ctx, {path: 'src'});
    expect(existsSync(path.join(ctx.root, 'src'))).toBe(false);
  });
});

describe('search', () => {
  it('finds content and file paths', async () => {
    const r = await searchTool(ctx, {pattern: 'const b'});
    expect(r.text).toBe('src/a.ts:2:const b = 2;');
    expect((await searchTool(ctx, {pattern: 'a\\.ts$', files_only: true})).text).toBe('src/a.ts');
    expect((await searchTool(ctx, {pattern: 'zzz'})).text).toBe('No matches.');
    await expect(searchTool(ctx, {pattern: '('})).rejects.toThrow(/invalid regex/);
  });
  it('converts globs', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.tsx').test('src/ui/x.tsx')).toBe(true);
    expect(globToRegExp('*.{ts,tsx}').test('a.tsx')).toBe(true);
  });
});

describe('list', () => {
  it('lists folders first with sizes, recurses by depth, skips hidden/heavy dirs', async () => {
    const {listTool} = await import('../src/tools/fs.js');
    await mkdir(path.join(ctx.root, 'src/ui'), {recursive: true});
    await writeFile(path.join(ctx.root, 'src/ui/x.tsx'), 'x');
    await mkdir(path.join(ctx.root, 'node_modules/pkg'), {recursive: true});
    await writeFile(path.join(ctx.root, '.env'), 'SECRET=1');
    await writeFile(path.join(ctx.root, 'README.md'), 'hello');
    const one = await listTool(ctx, {});
    expect(one.text).toBe('./\nsrc/\nREADME.md  (5 B)');
    const deep = await listTool(ctx, {path: 'src', depth: 2});
    expect(deep.text).toBe('src/\nui/\n  x.tsx  (1 B)\na.ts  (40 B)');
    const all = await listTool(ctx, {all: true});
    expect(all.text).toContain('node_modules/');
    expect(all.text).toContain('.env');
    await expect(listTool(ctx, {path: '../'})).rejects.toThrow(/outside the project/);
  });
});

describe('large files (streaming)', () => {
  it('reads the start of a big file without loading it, and edits it in constant memory', async () => {
    const {writeFile: wf, stat: st, readFile: rf} = await import('node:fs/promises');
    const big = path.join(ctx.root, 'big.log');
    const line = 'x'.repeat(99) + '\n';
    // ~10 MB with a unique marker that straddles the 1 MB streaming chunk boundary.
    const head = line.repeat(10485); // 1,048,500 bytes
    const marker = 'NEEDLE-ACROSS-THE-BOUNDARY';
    await wf(big, head + 'pad' + marker + '\n' + line.repeat(95000));
    expect((await st(big)).size).toBeGreaterThan(8 * 1024 * 1024);
    const t0 = Date.now();
    const r = await readTool(ctx, {path: 'big.log', limit: 2});
    expect(r.text.split('\n')[0]).toBe('     1\t' + 'x'.repeat(99));
    expect(r.text).toContain('more lines follow');
    expect(Date.now() - t0).toBeLessThan(500);
    const e = await editTool(ctx, {path: 'big.log', old_string: marker, new_string: 'REPLACED'});
    expect(e.text).toMatch(/1 replacement \(streamed/);
    const after = await rf(big, 'utf8');
    expect(after.includes(marker)).toBe(false);
    expect(after.slice(head.length, head.length + 11)).toBe('padREPLACED');
    await expect(editTool(ctx, {path: 'big.log', old_string: 'x'.repeat(99), new_string: 'y'})).rejects.toThrow(/matches \d+ places/);
  });
});
