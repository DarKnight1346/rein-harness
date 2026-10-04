import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {denialNote, seatbeltProfile, wrap} from '../src/tools/sandbox.js';
import {ToolHost} from '../src/tools/host.js';

const project = () => {
  const p = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-sbx-')));
  mkdirSync(path.join(p, '.git', 'hooks'), {recursive: true});
  return p;
};

describe('sandbox', () => {
  // Seatbelt is macOS only (Windows has no sandbox, and its 8.3 temp paths don't round-trip).
  it.skipIf(process.platform === 'win32')('builds a write-limiting Seatbelt profile; strict also blocks the network', () => {
    const p = project();
    const write = seatbeltProfile({mode: 'write', roots: [p]});
    expect(write).toContain('(deny file-write* (require-not (require-any');
    expect(write).toContain(`(subpath "${p}")`);
    expect(write).toContain(`(subpath "${path.join(p, '.git/hooks')}")`);
    expect(write).not.toContain('network-outbound');
    expect(seatbeltProfile({mode: 'strict', roots: [p]})).toContain('(deny network-outbound (require-not (remote ip "localhost:*")))');
    expect(wrap({file: '/bin/sh', args: ['-c', 'true']}, {mode: 'off', roots: [p]})).toBeUndefined();
  });

  it.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))('really blocks writes outside the project and to git hooks (macOS)', () => {
    const p = project();
    const run = (cmd: string) => {
      const w = wrap({file: '/bin/sh', args: ['-c', cmd]}, {mode: 'write', roots: [p]})!;
      return spawnSync(w.file, w.args, {cwd: p, encoding: 'utf8'});
    };
    expect(run('echo ok > inside.txt').status).toBe(0);
    const probe = path.join(os.homedir(), `.rein-sandbox-test-${process.pid}`);
    const home = run(`echo no > ${probe}`);
    expect(home.status).not.toBe(0);
    expect(existsSync(probe)).toBe(false);
    expect(run('echo evil > .git/hooks/pre-commit').status).not.toBe(0);
  });

  it('explains likely sandbox denials to the model', () => {
    expect(denialNote('touch: /etc/x: Operation not permitted', {mode: 'write', roots: []})).toContain('unsandboxed: true');
    expect(denialNote('curl: (6) Could not resolve host: x.com', {mode: 'write', roots: []})).toBeUndefined();
    expect(denialNote('curl: (6) Could not resolve host: x.com', {mode: 'strict', roots: []})).toContain('no network');
  });

  it('leaving the sandbox always asks, even in bypass mode', async () => {
    const p = project();
    writeFileSync(path.join(p, 'a.txt'), 'x');
    const asked: string[] = [];
    const host = new ToolHost({root: p, mode: () => 'bypass', sandbox: () => 'write', approve: async (r) => (asked.push(r.summary), 'deny')});
    expect((await host.call('shell', {command: 'echo boxed'})).ok).toBe(true); // bypass: no prompt inside the sandbox
    expect(asked).toEqual([]);
    const res = await host.call('shell', {command: 'echo free', unsandboxed: true});
    expect(res.ok).toBe(false);
    expect(asked).toHaveLength(1);
    host.close();
  });
});
