import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {render} from 'ink';
import React from 'react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {describeLive, inboxFile, listLive, sendTo, watchInbox, writeLive} from '../src/host/live.js';
import {SessionsDashboard} from '../src/ui/SessionsDashboard.js';

let home: string;
const envHome = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-live-'));
  process.env.REIN_HOME = home;
});
afterEach(() => {
  if (envHome === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = envHome;
  rmSync(home, {recursive: true, force: true});
});
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
  return fn();
};

describe('multi-session dashboard', () => {
  it('lists running Reins, drops dead ones, and delivers messages to the inbox', async () => {
    writeLive({cwd: '/work/shop', title: 'Add retries', state: 'working', goal: 'retries ship'});
    writeLive({cwd: '/work/old', title: 'gone', state: 'idle'}, 999_999); // no such process
    const live = listLive();
    expect(live.map((l) => [l.pid, l.state, l.goal])).toEqual([[process.pid, 'working', 'retries ship']]);
    expect(describeLive(live[0]!, '/work')).toMatch(/^working +~\/shop  Add retries  ◎ retries ship  \(\d+s ago\)$/);
    const got: string[] = [];
    const stop = watchInbox((t) => got.push(t), process.pid, 50);
    sendTo(process.pid, 'also handle timeouts');
    expect(await until(() => got.length === 1)).toBe(true);
    expect(got).toEqual(['also handle timeouts']);
    stop();
    expect(() => sendTo(999_999, 'x')).toThrow(/no Rein is running/);
  }, 20_000); // starts real processes: slow on a busy CI runner

  it('sends a message from the dashboard, and attaches only background sessions', async () => {
    writeLive({cwd: '/work/api', title: 'Fix login', state: 'waiting', host: 'ab12cd34'});
    const stdin = Object.assign(new PassThrough(), {isTTY: true, setRawMode() {}, ref() {}, unref() {}}) as unknown as NodeJS.ReadStream;
    const stdout = Object.assign(new PassThrough(), {columns: 120, rows: 30, isTTY: true}) as unknown as NodeJS.WriteStream;
    let frame = '';
    (stdout as unknown as PassThrough).on('data', (d) => (frame += d.toString()));
    let choice: unknown;
    const app = render(React.createElement(SessionsDashboard, {onDone: (c) => (choice = c)}), {stdin, stdout, debug: true, patchConsole: false});
    expect(await until(() => frame.includes('Fix login'))).toBe(true);
    const type = async (s: string) => {
      (stdin as unknown as PassThrough).write(s);
      await new Promise((r) => setTimeout(r, 60));
    };
    await type('m');
    for (const ch of 'ship it') await type(ch);
    await type('\r');
    expect(await until(() => readFileSync(inboxFile(process.pid), 'utf8').includes('ship it'))).toBe(true);
    await type('\r');
    expect(choice).toEqual({attach: 'ab12cd34'});
    app.unmount();
  }, 20_000);
});
