import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {findIdes, IdeConnection} from '../src/ide/connection.js';
// @ts-expect-error a plain .mjs test fixture
import {startFakeIde} from './fixtures/fake-ide.mjs';

vi.setConfig({testTimeout: 20_000});
let ide: Awaited<ReturnType<typeof startFakeIde>>;
const project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-ide-proj-')));
const locks = mkdtempSync(path.join(os.tmpdir(), 'rein-ide-locks-'));

beforeAll(async () => {
  ide = await startFakeIde({token: 'secret-token'});
  process.env.REIN_IDE_LOCK_DIR = locks;
  writeFileSync(path.join(locks, `${ide.port}.lock`), JSON.stringify({workspaceFolders: [project], pid: process.pid, ideName: 'Visual Studio Code', transport: 'ws', authToken: 'secret-token'}));
  // Another editor on a different folder, and a dead one: neither should match.
  writeFileSync(path.join(locks, '1.lock'), JSON.stringify({workspaceFolders: ['/elsewhere'], pid: process.pid, ideName: 'Cursor', transport: 'ws'}));
  writeFileSync(path.join(locks, '2.lock'), JSON.stringify({workspaceFolders: [project], pid: 999_999_999, ideName: 'Gone', transport: 'ws'}));
});
afterAll(() => ide?.close());

describe('editor integration (Claude Code IDE extension protocol)', () => {
  it('finds the running editor whose workspace holds the project', () => {
    expect(findIdes(path.join(project)).map((l) => [l.port, l.ideName])).toEqual([[ide.port, 'Visual Studio Code']]);
    expect(findIdes(os.tmpdir())).toEqual([]);
  });

  it('connects with the auth token; a wrong token is refused', async () => {
    const [lock] = findIdes(project);
    await expect(IdeConnection.connect({...lock!, authToken: 'wrong'})).rejects.toThrow();
    expect(ide.seen.rejectedAuth).toBe(1);
    const conn = await IdeConnection.connect(lock!);
    expect(await conn.toolNames()).toEqual(expect.arrayContaining(['openDiff', 'getDiagnostics']));
    await conn.close();
  });

  it('shows diffs in the editor and reads the answer, including edits made there', async () => {
    const conn = await IdeConnection.connect(findIdes(project)[0]!);
    expect(await conn.openDiff('/p/a.ts', 'const a = 1;', 'a.ts (Rein)')).toEqual({answer: 'accepted', contents: 'const a = 1;'});
    expect((await conn.openDiff('/p/a.ts', 'REJECT me', 'a.ts (Rein)')).answer).toBe('rejected');
    expect((await conn.openDiff('/p/a.ts', 'EDIT me', 'a.ts (Rein)')).contents).toBe('EDIT me\n// edited in the IDE');
    expect(await conn.diagnostics('/p/a.ts')).toContain("Cannot find name 'foo'");
    await conn.close();
  });

  it('tracks the selection and @-mentions pushed by the editor', async () => {
    const conn = await IdeConnection.connect(findIdes(project)[0]!);
    const mentioned = new Promise((r) => conn.once('mention', r));
    await ide.notify('selection_changed', {filePath: '/p/a.ts', text: 'let x = 1;\nlet y = 2;', selection: {start: {line: 9, character: 0}, end: {line: 10, character: 10}}});
    await ide.notify('at_mentioned', {filePath: '/p/b.ts', lineStart: 4, lineEnd: 7});
    expect(await mentioned).toEqual({filePath: '/p/b.ts', lineStart: 5, lineEnd: 8});
    expect(conn.selection).toEqual({filePath: '/p/a.ts', text: 'let x = 1;\nlet y = 2;', startLine: 10, endLine: 11});
    await ide.notify('selection_changed', {filePath: '/p/a.ts', text: '', selection: {start: {line: 1, character: 0}, end: {line: 1, character: 0}}});
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.selection).toBeUndefined();
    await conn.close();
  });
});

describe('approvals as editor diffs', () => {
  it('computes the file a write/edit would produce, and skips other calls', async () => {
    const {proposedChange} = await import('../src/ide/review.js');
    const {writeFileSync: w} = await import('node:fs');
    const file = path.join(project, 'x.ts');
    w(file, 'const a = 1;\nconst b = 1;\n');
    const req = (tool: string, args: object, extra: object = {}) => ({tool: {name: tool}, args, summary: '', preview: '', ...extra}) as any;
    expect(proposedChange(req('write', {content: 'new'}), file)).toEqual({path: file, contents: 'new'});
    expect(proposedChange(req('edit', {old_string: '= 1', new_string: '= 2'}), file)!.contents).toBe('const a = 2;\nconst b = 1;\n');
    expect(proposedChange(req('edit', {old_string: '= 1', new_string: '= 2', replace_all: true}), file)!.contents).toBe('const a = 2;\nconst b = 2;\n');
    expect(proposedChange(req('edit', {old_string: 'missing', new_string: 'x'}), file)).toBeUndefined();
    expect(proposedChange(req('shell', {command: 'ls'}), file)).toBeUndefined();
    expect(proposedChange(req('write', {content: 'x'}, {outside: ['/etc/x']}), file)).toBeUndefined();
  });

  it('an approved change uses the version the user edited in the diff', async () => {
    const {ToolHost} = await import('../src/tools/host.js');
    const {readFileSync: r, writeFileSync: w} = await import('node:fs');
    const host = new ToolHost({root: project, mode: () => 'ask', approve: async () => 'once'});
    w(path.join(project, 'y.ts'), 'let v = 1;\n');
    await host.call('read', {path: 'y.ts'});
    host.useEditorVersion(host.pathsFor('edit', {path: 'y.ts'})[0]!, 'let v = 3; // tweaked in the editor\n');
    const res = await host.call('edit', {path: 'y.ts', old_string: 'v = 1', new_string: 'v = 2'});
    expect(res.ok).toBe(true);
    expect(res.text).toContain('changed your edit in their editor');
    expect(r(path.join(project, 'y.ts'), 'utf8')).toBe('let v = 3; // tweaked in the editor\n');
    host.close();
  });
});
