import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
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
  it('report the problems a turn introduced, once, at the end; and stop when idle', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-lsp-'));
    const file = path.join(root, 'a.ts');
    writeFileSync(file, 'const x = 1;\n// OLD thing\n');
    const lsp = new LspManager({config});
    const before = await lsp.before([file], root);
    writeFileSync(file, 'const x = 1;\n// OLD thing\nconst y = BAD;\n');
    expect(await lsp.after(before)).toBeUndefined(); // nothing mid-turn
    const note = await lsp.turnEnd();
    expect(note).toContain('left 1 problem');
    expect(note).toContain('a.ts:3:11 error fake X1');
    expect(note).not.toContain('old warning');
    // Next turn: the old problem is the new baseline; a clean change says nothing.
    const b2 = await lsp.before([file], root);
    writeFileSync(file, 'const x = 1;\n// OLD thing\nconst y = BAD;\nconst z = 3;\n');
    await lsp.after(b2);
    expect(await lsp.turnEnd()).toBeUndefined();
    expect(await lsp.turnEnd()).toBeUndefined(); // no changes at all: nothing to check
    expect(await lsp.diagnostics(root, file)).toContain('bad value on purpose');
    const pid = lsp.status()[0]!.pid!;
    expect(await lsp.stopIdle(Date.now() + 11 * 60_000)).toBe(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow(); // the process is really gone
  });

  it('tell whether problems the last check reported were fixed (for escalation)', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-lsp-'));
    const file = path.join(root, 'a.ts');
    writeFileSync(file, 'const x = 1;\n');
    const lsp = new LspManager({config});
    await lsp.after(await lsp.before([file], root));
    writeFileSync(file, 'const x = BAD;\n');
    expect(await lsp.turnEnd()).toContain('left 1 problem');
    expect(await lsp.stillThere()).toEqual([expect.stringContaining('a.ts:1:11 error fake X1')]); // the follow-up didn't fix it
    expect(await lsp.stillThere()).toEqual([]); // asked once per report
    await lsp.after(await lsp.before([file], root));
    writeFileSync(file, 'const x = BAD;\nconst y = BAD;\n');
    await lsp.turnEnd();
    writeFileSync(file, 'const x = 2;\n'); // fixed
    expect(await lsp.stillThere()).toEqual([]);
    await lsp.closeAll();
  });

  it('do not report breakage the turn fixed again (a refactor in steps), but catch a broken importer', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-lsp-dep-'));
    writeFileSync(path.join(root, 'lib.ts'), 'export const v = 1;\n');
    writeFileSync(path.join(root, 'app.ts'), "import {v} from './lib';\n// uses lib.ts\n");
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', '-A'], {cwd: root});
    const lsp = new LspManager({config});
    const lib = path.join(root, 'lib.ts');
    const app = path.join(root, 'app.ts');
    // Step 1 breaks the importer, step 2 fixes it: the turn ends clean.
    await lsp.after(await lsp.before([lib], root));
    writeFileSync(lib, 'export const v = 1; // BROKEN\n');
    await lsp.after(await lsp.before([lib], root));
    const b = await lsp.before([app], root);
    writeFileSync(app, "import {v} from './lib';\n");
    await lsp.after(b);
    expect(await lsp.turnEnd()).toBeUndefined();
    // A turn that leaves the importer broken is caught, through the dependent it never opened.
    writeFileSync(lib, 'export const v = 1;\n');
    writeFileSync(app, "import {v} from './lib';\n// uses lib.ts\n");
    await lsp.turnEnd();
    const b2 = await lsp.before([lib], root);
    writeFileSync(lib, 'export const v = 2; // BROKEN\n');
    await lsp.after(b2);
    const t = Date.now();
    expect(await lsp.turnEnd()).toContain('app.ts:2:1 error fake X2: lib.ts is broken');
    expect(Date.now() - t).toBeLessThan(process.platform === "win32" ? 5000 : 1400);
    await lsp.closeAll();
  });

  it("callers: vendored code isn't checked, and only errors count in files the turn didn't edit", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-lsp-vendor-'));
    mkdirSync(path.join(root, 'vendor', 'pkg'), {recursive: true});
    writeFileSync(path.join(root, 'lib.ts'), 'export const v = 1;\n');
    writeFileSync(path.join(root, 'app.ts'), "import {v} from './lib';\n");
    writeFileSync(path.join(root, 'vendor', 'pkg', 'dep.ts'), '// uses ../../lib.ts\n');
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['add', '-A'], {cwd: root});
    const lsp = new LspManager({config});
    const lib = path.join(root, 'lib.ts');
    const b = await lsp.before([lib], root);
    writeFileSync(lib, 'export const v = 2; // BROKEN\n');
    // A warning in the caller that only shows up now (a server's slower analysis), not from this edit.
    writeFileSync(path.join(root, 'app.ts'), "import {v} from './lib'; // OLD\n");
    await lsp.after(b);
    expect(await lsp.turnEnd()).toBeUndefined();
    await lsp.closeAll();
  });

  it('end-of-turn check through the runtime, for edits made with the tool host', async () => {
    const {ToolHost} = await import('../src/tools/host.js');
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-lsp-host-'));
    writeFileSync(path.join(root, 'b.ts'), 'export const ok = 1;\n');
    const lsp = new LspManager({config});
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', diagnostics: {before: (f, r) => lsp.before(f, r), after: (s) => lsp.after(s as never)}});
    await host.call('read', {path: 'b.ts'});
    const res = await host.call('edit', {path: 'b.ts', old_string: 'export const ok = 1;', new_string: 'export const ok = BAD;'});
    expect(res.ok).toBe(true);
    expect(res.text).not.toContain('problem'); // edits stay quiet
    // A new file: no wait before it's written.
    const t = Date.now();
    await host.call('write', {path: 'c.ts', content: 'export const c = BAD;\n'});
    expect(Date.now() - t).toBeLessThan(process.platform === "win32" ? 5000 : 1400);
    const note = await lsp.turnEnd();
    expect(note).toContain('left 2 problems');
    expect(note).toMatch(/b\.ts:1:\d+ error fake X1/);
    expect(note).toContain('c.ts:1:18 error fake X1');
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

describe('language server registry', () => {
  it('matches files to servers by name and extension', async () => {
    const {serverFor, languageIdFor, SERVERS} = await import('../src/lsp/servers.js');
    const id = (f: string) => serverFor(f)?.id;
    expect(id('kernel/main.cpp')).toBe('cpp');
    expect(id('boot/start.S')).toBe('asm');
    expect(id('boot/start.asm')).toBe('asm');
    expect(id('x/Dockerfile')).toBe('dockerfile');
    expect(id('CMakeLists.txt')).toBe('cmake');
    expect(id('notes.txt')).toBeUndefined();
    expect(id('analysis.R')).toBe('r');
    expect(languageIdFor(serverFor('a.mm')!, 'a.mm')).toBe('objective-cpp');
    // Every extension belongs to one server (no silent shadowing).
    const seen = new Map<string, string>();
    for (const s of SERVERS) for (const e of Object.keys(s.languages)) {
      expect(seen.get(e), `${e}: ${seen.get(e)} and ${s.id}`).toBeUndefined();
      seen.set(e, s.id);
    }
  });
  it('says why a server cannot be installed', async () => {
    const {installable, serverById} = await import('../src/lsp/servers.js');
    const swift = installable(serverById('swift')!);
    expect(swift.ok).toBe(false);
    if (!swift.ok) expect(swift.why).toMatch(/Xcode/);
  });
  it('unpacks .gz, tar archives and plain binaries', async () => {
    const {unpack} = await import('../src/lsp/servers.js');
    const {gzipSync} = await import('node:zlib');
    const {execFileSync} = await import('node:child_process');
    const {readFileSync} = await import('node:fs');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-unpack-'));
    const gz = path.join(dir, 'tool.gz');
    writeFileSync(gz, gzipSync('gz-binary'));
    const out1 = mkdtempSync(path.join(dir, 'a-'));
    await unpack(gz, 'tool-x86_64.gz', out1, 'tool');
    expect(readFileSync(path.join(out1, 'tool'), 'utf8')).toBe('gz-binary');
    const raw = path.join(dir, 'raw');
    writeFileSync(raw, 'raw-binary');
    const out2 = mkdtempSync(path.join(dir, 'b-'));
    await unpack(raw, 'tool-macos', out2, 'tool');
    expect(readFileSync(path.join(out2, 'tool'), 'utf8')).toBe('raw-binary');
    const src = mkdtempSync(path.join(dir, 'src-'));
    mkdirSync(path.join(src, 'bin'));
    writeFileSync(path.join(src, 'bin', 'tool'), 'tar-binary');
    const tgz = path.join(dir, 'tool.tar.gz');
    execFileSync('tar', ['-czf', tgz, '-C', src, 'bin']);
    const out3 = mkdtempSync(path.join(dir, 'c-'));
    await unpack(tgz, 'tool.tar.gz', out3, 'bin/tool');
    expect(readFileSync(path.join(out3, 'bin', 'tool'), 'utf8')).toBe('tar-binary');
    await expect(unpack(raw, 'tool.tar.gz', mkdtempSync(path.join(dir, 'd-')), 'tool')).rejects.toThrow();
  });
});
