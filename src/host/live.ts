import {appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync} from 'node:fs';
import path from 'node:path';
import {reinHome} from '../store/paths.js';
import {alive} from './index.js';

/**
 * The multi-session dashboard's data (`rein sessions`, `/sessions`): every interactive Rein keeps a
 * small status file (~/.rein/live/<pid>.json: folder, title, idle / working / waiting for you, goal)
 * and watches an inbox next to it, so a message sent from the dashboard arrives as if you typed it.
 */
export type LiveState = 'idle' | 'working' | 'waiting';
export type Live = {pid: number; cwd: string; title: string; state: LiveState; goal?: string; host?: string; model?: string; updatedAt: number};

export const liveDir = () => path.join(reinHome(), 'live');
const file = (pid: number) => path.join(liveDir(), `${pid}.json`);
export const inboxFile = (pid: number) => path.join(liveDir(), `${pid}.inbox`);

export function writeLive(l: Omit<Live, 'pid' | 'updatedAt'>, pid = process.pid): void {
  try {
    mkdirSync(liveDir(), {recursive: true});
    writeFileSync(file(pid), JSON.stringify({...l, pid, updatedAt: Date.now()} satisfies Live));
  } catch {}
}

export function removeLive(pid = process.pid): void {
  rmSync(file(pid), {force: true});
  rmSync(inboxFile(pid), {force: true});
}

/** Every running Rein (files of ones that died are removed). */
export function listLive(): Live[] {
  let names: string[] = [];
  try {
    names = readdirSync(liveDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Live[] = [];
  for (const n of names) {
    try {
      const l = JSON.parse(readFileSync(path.join(liveDir(), n), 'utf8')) as Live;
      if (alive(l.pid)) out.push(l);
      else removeLive(l.pid);
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Send a message to a running Rein: it arrives as if typed there. */
export function sendTo(pid: number, text: string): void {
  if (!alive(pid)) throw new Error(`no Rein is running with pid ${pid}`);
  mkdirSync(liveDir(), {recursive: true});
  appendFileSync(inboxFile(pid), `${JSON.stringify({text, at: Date.now()})}\n`);
}

/** Watch this process's inbox; each new message goes to `onMessage`. Returns the stop function. */
export function watchInbox(onMessage: (text: string) => void, pid = process.pid, intervalMs = 700): () => void {
  const f = inboxFile(pid);
  mkdirSync(liveDir(), {recursive: true});
  writeFileSync(f, '');
  let offset = 0;
  let partial = '';
  const read = () => {
    let size = 0;
    try {
      size = statSync(f).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = openSync(f, 'r');
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = size;
    const lines = (partial + buf.toString()).split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) {
      try {
        const m = JSON.parse(l) as {text?: string};
        if (m.text?.trim()) onMessage(m.text);
      } catch {}
    }
  };
  // Polling, not fs.watch: it behaves the same on every platform and filesystem.
  watchFile(f, {interval: intervalMs}, read);
  return () => unwatchFile(f, read);
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const LABEL: Record<LiveState, string> = {idle: 'idle', working: 'working', waiting: 'waiting for you'};

export function describeLive(l: Live, home = process.env.HOME ?? ''): string {
  const where = home && l.cwd.startsWith(home) ? `~${l.cwd.slice(home.length)}` : l.cwd;
  return `${LABEL[l.state].padEnd(15)} ${where}  ${l.title.slice(0, 60)}${l.goal ? `  ◎ ${l.goal.slice(0, 40)}` : ''}${l.host ? `  [background ${l.host}]` : ''}  (${ago(l.updatedAt)} ago)`;
}
