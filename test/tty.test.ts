import stripAnsi from 'strip-ansi';
import os from 'node:os';
import {describe, expect, it} from 'vitest';
import {ShellManager, waitingForInput} from '../src/tools/shells.js';

// Every platform: Windows runs these through ConPTY (node-pty) in Git Bash, as on CI.
const posix = true;

describe('interactive (terminal) commands', () => {
  it('know a prompt from a quiet build', () => {
    expect(waitingForInput('Name: ', 'Name: ', false)).toBe(true);
    expect(waitingForInput('Proceed? (y/n)', '', false)).toBe(true);
    expect(waitingForInput('Enter password', '', false)).toBe(true);
    expect(waitingForInput('', '', true)).toBe(true); // full-screen program
    expect(waitingForInput('Compiling 41 files', '', false)).toBe(false);
  });

  it.runIf(posix)('signal when they wait, take the answer, and finish', async () => {
    const shells = new ShellManager();
    shells.interactiveUser = true;
    const asked = new Promise<number>((r) => shells.once('input', (s) => r(s.id)));
    const {done} = shells.start('[ -t 0 ] && echo tty-yes; printf "Name: "; read n && echo "hi $n"', {cwd: os.tmpdir(), background: false, tty: true});
    const id = await asked;
    expect(shells.get(id)!.waiting).toBe(true);
    // Windows' ConPTY repaints with cursor moves: compare the text, not the raw bytes.
    expect(stripAnsi(shells.screen(id)).replace(/\s+/g, ' ')).toContain('Name:');
    shells.write(id, 'bob\r');
    const s = await done;
    expect(s.exitCode).toBe(0);
    expect(shells.tail(s)).toContain('tty-yes');
    expect(shells.tail(s)).toContain('hi bob');
  });

  it.runIf(posix)('stop instead of hanging when nobody can answer (headless)', async () => {
    const shells = new ShellManager();
    const t = Date.now();
    const s = await shells.start('printf "Continue? "; read x', {cwd: os.tmpdir(), background: false, tty: true}).done;
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(shells.tail(s)).toMatch(/Continue\? *\n\[it waited for input, and nobody can answer/);
    expect(s.noUser).toBe(true);
  });

  it.runIf(process.platform === 'darwin')('work without node-pty too (script)', async () => {
    process.env.REIN_NO_NODE_PTY = '1';
    const mod = await import('../src/tools/shells.js?nopty' as string);
    const shells = new mod.ShellManager();
    shells.interactiveUser = true;
    const asked = new Promise<number>((r) => shells.once('input', (s: {id: number}) => r(s.id)));
    const {done} = shells.start('[ -t 0 ] && echo tty-yes; printf "Name: "; read n && echo "hi $n"', {cwd: os.tmpdir(), background: false, tty: true});
    shells.write(await asked, 'ann\n');
    const s = await done;
    delete process.env.REIN_NO_NODE_PTY;
    expect(shells.tail(s)).toContain('tty-yes');
    expect(shells.tail(s)).toContain('hi ann');
  });
});

describe('terminals that report no size', () => {
  it('get one, so Ink never takes the /dev/tty fallback that leaks a descriptor per frame', async () => {
    const {EventEmitter} = await import('node:events');
    const {ensureTerminalSize} = await import('../src/ui/resizeFix.js');
    const out = Object.assign(new EventEmitter(), {isTTY: true, columns: 0, rows: 0}) as unknown as NodeJS.WriteStream;
    ensureTerminalSize(out, {COLUMNS: '120'});
    expect([out.columns, out.rows]).toEqual([120, 30]);
    out.columns = 0; // a resize that reports zero again
    out.emit('resize');
    expect(out.columns).toBe(120);
  });
});
