import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {reinHome} from '../store/paths.js';

/**
 * Background sessions (`rein --background`, `rein attach`): a small host process, detached from the
 * terminal, owns a pseudo-terminal running Rein itself. Terminals attach to it over a local socket
 * (a named pipe on Windows) and see the same screen; closing the terminal only detaches, so the
 * session keeps working. Ctrl+\ detaches on purpose. The host ends when Rein inside it exits.
 */
export type HostInfo = {id: string; pid: number; cwd: string; socket: string; startedAt: number; title?: string};

export const DETACH_KEY = 0x1c; // Ctrl+\

/** How to start Rein again: node's own flags (a TypeScript loader when run from source) and the entry script. */
export const reinCli = () => [...process.execArgv, process.argv[1]!];
const RING = 256 * 1024;

export const hostsDir = () => path.join(reinHome(), 'hosts');
const infoFile = (id: string) => path.join(hostsDir(), `${id}.json`);
export const socketPath = (id: string) => (process.platform === 'win32' ? `\\\\.\\pipe\\rein-${id}` : path.join(os.tmpdir(), `rein-${process.getuid?.() ?? 'u'}-${id}.sock`));

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Running hosts (entries of hosts that died are removed). */
export function listHosts(): HostInfo[] {
  let files: string[] = [];
  try {
    files = readdirSync(hostsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: HostInfo[] = [];
  for (const f of files) {
    try {
      const h = JSON.parse(readFileSync(path.join(hostsDir(), f), 'utf8')) as HostInfo;
      if (alive(h.pid)) out.push(h);
      else rmSync(path.join(hostsDir(), f), {force: true});
    } catch {}
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

type Msg = {t: 'in'; d: string} | {t: 'resize'; cols: number; rows: number} | {t: 'out'; d: string} | {t: 'exit'; code: number};
const send = (s: net.Socket, m: Msg) => s.writable && s.write(JSON.stringify(m) + '\n');
function onLines(s: net.Socket, fn: (m: Msg) => void): void {
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        fn(JSON.parse(line) as Msg);
      } catch {}
    }
  });
}

/**
 * The host process itself (`rein host <id> …`): runs `file args` in a pseudo-terminal and serves it.
 * Resolves when the program exits.
 */
export async function runHost(o: {id: string; cwd: string; file: string; args: string[]; cols: number; rows: number; env?: Record<string, string>}): Promise<number> {
  const pty = await import('@lydell/node-pty');
  const term = pty.spawn(o.file, o.args, {name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: {...process.env, ...o.env, REIN_HOST: o.id, TERM: 'xterm-256color'} as Record<string, string>});
  let ring = Buffer.alloc(0);
  let client: net.Socket | undefined;
  term.onData((d) => {
    ring = Buffer.concat([ring, Buffer.from(d)]);
    if (ring.length > RING) ring = ring.subarray(ring.length - RING);
    if (client) send(client, {t: 'out', d: Buffer.from(d).toString('base64')});
  });
  const sock = socketPath(o.id);
  if (process.platform !== 'win32') rmSync(sock, {force: true});
  const server = net.createServer((s) => {
    // One terminal at a time: a new attach takes over from the old one.
    if (client && client !== s) client.end();
    client = s;
    if (ring.length) send(s, {t: 'out', d: ring.toString('base64')}); // the screen so far
    onLines(s, (m) => {
      if (m.t === 'in') term.write(Buffer.from(m.d, 'base64').toString());
      else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) {
        // Resizing also makes a full-screen program redraw for the new terminal.
        if (m.cols === term.cols && m.rows === term.rows) term.resize(m.cols, m.rows + 1);
        term.resize(m.cols, m.rows);
      }
    });
    s.on('close', () => client === s && (client = undefined));
    s.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(sock, r));
  if (process.platform !== 'win32') chmodSync(sock, 0o600);
  mkdirSync(hostsDir(), {recursive: true});
  writeFileSync(infoFile(o.id), JSON.stringify({id: o.id, pid: process.pid, cwd: o.cwd, socket: sock, startedAt: Date.now()} satisfies HostInfo));
  return new Promise((resolve) => {
    term.onExit(({exitCode}) => {
      if (client) send(client, {t: 'exit', code: exitCode});
      client?.end();
      server.close();
      rmSync(infoFile(o.id), {force: true});
      if (process.platform !== 'win32') rmSync(sock, {force: true});
      resolve(exitCode);
    });
  });
}

/** Start a host in the background for `args` (Rein's own arguments); resolves once it's listening. */
export async function startHost(cwd: string, args: string[], size = {cols: process.stdout.columns || 100, rows: process.stdout.rows || 30}, launch?: {file: string; args: string[]}, cli = reinCli()): Promise<HostInfo> {
  const id = randomBytes(4).toString('hex');
  const target = launch ?? {file: process.execPath, args: [...cli, ...args]};
  const child = spawn(process.execPath, [...cli, 'host', id, String(size.cols), String(size.rows), target.file, ...target.args], {cwd, detached: true, stdio: 'ignore', windowsHide: true});
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (existsSync(infoFile(id))) {
      const h = listHosts().find((x) => x.id === id);
      if (h) return h;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the background session didn’t start (is node-pty installed? npm install -g rein-harness reinstalls it)');
}

/** Attach this terminal to a host: its screen here, keys there. Resolves 'detached' (Ctrl+\ or the host went away) or 'exited'. */
export function attach(h: HostInfo, io: {stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream} = {stdin: process.stdin, stdout: process.stdout}): Promise<'detached' | 'exited'> {
  return new Promise((resolve) => {
    const s = net.connect(h.socket);
    let result: 'detached' | 'exited' = 'detached';
    const resize = () => send(s, {t: 'resize', cols: io.stdout.columns || 100, rows: io.stdout.rows || 30});
    const input = (d: Buffer) => {
      const i = d.indexOf(DETACH_KEY);
      if (i >= 0) {
        if (i > 0) send(s, {t: 'in', d: d.subarray(0, i).toString('base64')});
        s.end();
        return;
      }
      send(s, {t: 'in', d: d.toString('base64')});
    };
    const cleanup = () => {
      io.stdin.off('data', input);
      io.stdout.off('resize', resize);
      if (io.stdin.isTTY) io.stdin.setRawMode(false);
      io.stdin.pause();
      resolve(result);
    };
    s.on('connect', () => {
      if (io.stdin.isTTY) io.stdin.setRawMode(true);
      io.stdin.resume();
      io.stdin.on('data', input);
      io.stdout.on('resize', resize);
      resize();
    });
    onLines(s, (m) => {
      if (m.t === 'out') io.stdout.write(Buffer.from(m.d, 'base64'));
      else if (m.t === 'exit') result = 'exited';
    });
    s.on('close', cleanup);
    s.on('error', () => {});
  });
}

export function killHost(h: HostInfo): void {
  try {
    process.kill(h.pid);
  } catch {}
  rmSync(infoFile(h.id), {force: true});
}
