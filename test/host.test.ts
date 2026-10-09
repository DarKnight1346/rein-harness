import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {attach, DETACH_KEY, listHosts, runHost} from '../src/host/index.js';

let home: string;
const envHome = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  process.env.REIN_HOME = home;
});
afterEach(() => {
  if (envHome === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = envHome;
  rmSync(home, {recursive: true, force: true});
});

function terminal() {
  const stdin = Object.assign(new PassThrough(), {isTTY: false, setRawMode() {}}) as unknown as NodeJS.ReadStream & PassThrough;
  let seen = '';
  const stdout = Object.assign(new PassThrough(), {columns: 80, rows: 24}) as unknown as NodeJS.WriteStream & PassThrough;
  stdout.on('data', (d) => (seen += d.toString()));
  return {stdin, stdout, seen: () => seen};
}
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
  return fn();
};

describe.runIf(process.platform !== 'win32')('background sessions', () => {
  it('keeps the program running between attaches and replays its screen', async () => {
    const exited = runHost({id: 'test1', cwd: os.tmpdir(), file: 'sh', args: ['-c', 'echo ready; cat'], cols: 80, rows: 24});
    expect(await until(() => listHosts().some((h) => h.id === 'test1'))).toBe(true);
    const host = listHosts().find((h) => h.id === 'test1')!;

    const a = terminal();
    const first = attach(host, a);
    expect(await until(() => a.seen().includes('ready'))).toBe(true);
    a.stdin.write('hello\r');
    expect(await until(() => a.seen().includes('hello'))).toBe(true);
    a.stdin.write(Buffer.from([DETACH_KEY]));
    expect(await first).toBe('detached');
    expect(listHosts().map((h) => h.id)).toContain('test1'); // still running

    const b = terminal();
    const second = attach(host, b);
    expect(await until(() => b.seen().includes('ready') && b.seen().includes('hello'))).toBe(true); // the screen so far
    b.stdin.write(Buffer.from([4])); // Ctrl+D: cat ends, so does the session
    expect(await second).toBe('exited');
    expect(await exited).toBe(0);
    expect(listHosts()).toEqual([]);
  }, 20_000);
});

describe.runIf(process.platform !== 'win32')('rein --background', () => {
  it('starts a detached host through the CLI that outlives the attach', async () => {
    const {startHost, killHost} = await import('../src/host/index.js');
    const cli = ['--import', 'tsx', path.resolve('src/cli.ts')];
    const h = await startHost(process.cwd(), [], {cols: 80, rows: 24}, {file: 'sh', args: ['-c', 'echo hosted; sleep 60']}, cli);
    expect(h.pid).not.toBe(process.pid);
    const t = terminal();
    const session = attach(h, t);
    expect(await until(() => t.seen().includes('hosted'))).toBe(true);
    t.stdin.write(Buffer.from([DETACH_KEY]));
    expect(await session).toBe('detached');
    expect(listHosts().map((x) => x.id)).toContain(h.id);
    killHost(h);
    expect(await until(() => !listHosts().some((x) => x.id === h.id))).toBe(true);
  }, 60_000); // starting the CLI from TypeScript source is slow on a busy machine
});
