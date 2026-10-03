import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {ShellManager, shellStatusText} from '../src/tools/shells.js';
import {ToolHost} from '../src/tools/host.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ShellManager', () => {
  it('runs foreground commands and captures output + exit code', async () => {
    const m = new ShellManager();
    const {shell, done} = m.start('echo hi; echo err >&2; printf "50%%\\r100%%\\n"; exit 3', {cwd: os.tmpdir(), background: false});
    const s = await done;
    expect(s).toBe(shell);
    expect([...s.lines].sort()).toEqual(['100%', 'err', 'hi']); // stdout/stderr order isn't guaranteed
    expect([s.status, s.exitCode]).toEqual(['exited', 3]);
    expect(shellStatusText(s)).toMatch(/^exit 3 after/);
  });
  it('times out at the timeout, clamped by the user cap', async () => {
    const m = new ShellManager();
    const t0 = Date.now();
    const s = await m.start('sleep 5', {cwd: os.tmpdir(), background: false, timeoutMs: 60_000, maxMs: 1000}).done;
    expect(s.status).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(4000);
  });
  it('runs in the background and kills the whole process group', async () => {
    const m = new ShellManager();
    const {shell} = m.start('(sleep 30 & wait) & while true; do echo tick; sleep 0.1; done', {cwd: os.tmpdir(), background: true});
    await wait(400);
    expect(m.running({background: true})).toHaveLength(1);
    expect(shell.lines.filter((l) => l === 'tick').length).toBeGreaterThan(1);
    expect(m.kill(shell.id)).toBe(true);
    await wait(300);
    expect(shell.status).toBe('killed');
    expect(m.running()).toHaveLength(0);
  });
});

describe('shell tools via ToolHost', () => {
  it('goes through approval, runs foreground/background, reads logs, kills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rein-proj-'));
    const asked: string[] = [];
    const host = new ToolHost({root, mode: () => 'ask', approve: async (r) => (asked.push(r.summary), 'once')});
    const fg = await host.call('shell', {command: 'pwd; echo ok'});
    expect(fg.ok).toBe(true);
    expect(fg.text).toContain('[exit 0');
    expect(fg.text).toContain('ok');
    expect(asked).toEqual(['$ pwd; echo ok']);
    const fail = await host.call('shell', {command: 'exit 2'});
    expect(fail.ok).toBe(false);
    const bg = await host.call('shell', {command: 'echo started; sleep 30', background: true});
    expect(bg.text).toMatch(/Started background shell #3/);
    await wait(300);
    expect((await host.call('shell_logs', {id: 3})).text).toContain('started');
    expect((await host.call('shell_logs', {})).text).toMatch(/#3 background · running/);
    expect((await host.call('shell_kill', {id: 3})).text).toMatch(/Stopped #3/);
    expect((await host.call('shell', {command: 'ls', cwd: '../'})).text).toMatch(/outside the project/);
    host.close();
  });
});
