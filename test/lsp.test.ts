import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {parseFrames} from '../src/lsp/rpc.js';
import {LspManager, newProblems} from '../src/lsp/manager.js';
import {DEFAULT_CONFIG} from '../src/store/config.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lsp.mjs');
const config = () => ({...DEFAULT_CONFIG, lspServers: {typescript: {command: process.execPath, args: [fake]}}});

describe('LSP framing', () => {
  it('parses messages split across chunks, several per chunk, with multi-byte text', () => {
    const frame = (o: unknown) => {
      const b = Buffer.from(JSON.stringify(o));
      return Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b]);
    };
    const all = Buffer.concat([frame({a: 'é—ü'}), frame({b: 2})]);
    const first = parseFrames(all.subarray(0, 25));
    expect(first.messages).toEqual([]);
    const rest = parseFrames(Buffer.concat([first.rest, all.subarray(25)]));
    expect(rest.messages).toEqual([{a: 'é—ü'}, {b: 2}]);
    expect(rest.rest.length).toBe(0);
  });
  it('counts a problem as new only if it was not there before (lines move)', () => {
    const d = (message: string, line: number, severity = 1) => ({message, severity, range: {start: {line, character: 0}, end: {line, character: 1}}});
    expect(newProblems([d('a', 1), d('w', 2, 2)], [d('a', 5), d('w', 6, 2), d('b', 7)]).map((x) => x.message)).toEqual(['b']);
    expect(newProblems([], [d('hint', 1, 4)])).toEqual([]); // hints aren't reported
  });
});

describe('built-in language servers', () => {
  it('report only the problems an edit introduced, and stop when idle', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-lsp-'));
    const file = path.join(root, 'a.ts');
    writeFileSync(file, 'const x = 1;\n// OLD thing\n');
    const lsp = new LspManager({config});
    const before = await lsp.before([file], root);
    writeFileSync(file, 'const x = 1;\n// OLD thing\nconst y = BAD;\n');
    const note = await lsp.after(before);
    expect(note).toContain('introduced 1 problem');
    expect(note).toContain('a.ts:3:11 error fake X1');
    expect(note).not.toContain('old warning');
    // A clean edit says nothing.
    const b2 = await lsp.before([file], root);
    writeFileSync(file, 'const x = 1;\n// OLD thing\nconst y = BAD;\nconst z = 3;\n');
    expect(await lsp.after(b2)).toBeUndefined();
    expect(await lsp.diagnostics(root, file)).toContain('bad value on purpose');
    const pid = lsp.status()[0]!.pid!;
    expect(await lsp.stopIdle(Date.now() + 11 * 60_000)).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow(); // the process is really gone
  });

  it('catch an edit that breaks a file importing the edited one', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-lsp-dep-'));
    writeFileSync(path.join(root, 'lib.ts'), 'export const v = 1;\n');
    writeFileSync(path.join(root, 'app.ts'), "import {v} from './lib';\n// uses lib.ts\n");
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', '-A'], {cwd: root});
    const lsp = new LspManager({config});
    const lib = path.join(root, 'lib.ts');
    const b = await lsp.before([lib], root);
    expect(b.files.map((f) => path.basename(f.file)).sort()).toEqual(['app.ts', 'lib.ts']);
    writeFileSync(lib, 'export const v = 1; // BROKEN\n');
    expect(await lsp.after(b)).toContain('app.ts:2:1 error fake X2: lib.ts is broken');
    // A clean edit returns quickly although the server republishes nothing.
    const b2 = await lsp.before([lib], root);
    writeFileSync(lib, 'export const v = 1; // BROKEN\nexport const w = 2;\n');
    const t = Date.now();
    expect(await lsp.after(b2)).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(1400);
    await lsp.closeAll();
  });

  it('report through the tool host on edits', async () => {
    const {ToolHost} = await import('../src/tools/host.js');
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-lsp-host-'));
    writeFileSync(path.join(root, 'b.ts'), 'export const ok = 1;\n');
    const lsp = new LspManager({config});
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', diagnostics: {before: (f, r) => lsp.before(f, r), after: (s) => lsp.after(s as never)}});
    await host.call('read', {path: 'b.ts'});
    const res = await host.call('edit', {path: 'b.ts', old_string: 'export const ok = 1;', new_string: 'export const ok = BAD;'});
    expect(res.ok).toBe(true);
    expect(res.text).toContain('[Diagnostics: this edit introduced 1 problem');
    // A new file: no wait before it's written, and its errors are still reported.
    const t = Date.now();
    const created = await host.call('write', {path: 'c.ts', content: 'export const c = BAD;\n'});
    expect(created.text).toContain('c.ts:1:18 error fake X1');
    expect(Date.now() - t).toBeLessThan(1400);
    host.close();
    await lsp.closeAll();
  });
});

describe('askEvenInBypass', () => {
  it('asks in bypass mode, and a refusal says not to retry', async () => {
    const {ToolHost} = await import('../src/tools/host.js');
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-ask-'));
    const asked: string[] = [];
    const host = new ToolHost({root, mode: () => 'bypass', approve: async (r) => (asked.push(r.tool.name), 'deny')});
    host.register({name: 'installer', label: 'Install', description: 'x', inputSchema: {type: 'object', properties: {}}, mutating: true, alwaysAsk: true, askEvenInBypass: true, summarize: () => '', run: async () => ({ok: true, text: 'installed'})});
    const r = await host.call('installer', {});
    expect(asked).toEqual(['installer']);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Don't retry");
    host.close();
  });
});
