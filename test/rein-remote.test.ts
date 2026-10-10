import {createHash} from 'node:crypto';
import {chmodSync, mkdtempSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Previews} from '../src/preview/registry.js';
import {installRemote, parseSums, remoteBinary, remoteTarget, remoteWindows, startRemote} from '../src/preview/remote.js';
import {previewTool} from '../src/preview/tool.js';
import {saveWebConfig} from '../src/webui/auth.js';
import {startServer} from '../src/webui/server.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-webui-worker.mjs');
let home: string;
const saved = {home: process.env.REIN_HOME, remote: process.env.FAKE_REMOTE};
const closers: (() => unknown)[] = [];
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-remote-'));
  process.env.REIN_HOME = home;
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const [k, v] of [['REIN_HOME', saved.home], ['FAKE_REMOTE', saved.remote]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
});

/** A stand-in for `rein-remote serve`: its web client, and a WebSocket that echoes, behind a token. */
async function fakeRemote(token: string) {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    if (req.url === '/rein-remote.js') return void (res.writeHead(200, {'content-type': 'text/javascript'}), res.end('export const connect = () => "rein-remote client";'));
    res.writeHead(404).end();
  });
  const sockets = new Set<net.Socket>();
  srv.on('upgrade', (req, socket: net.Socket) => {
    sockets.add(socket);
    seen.push(req.url ?? '');
    if (!req.url?.endsWith(`token=${token}`)) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (d) => socket.write(d)); // echo
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => (sockets.forEach((x) => x.destroy()), srv.closeAllConnections(), srv.close(r))));
  return {port: (srv.address() as net.AddressInfo).port, seen};
}

/** A raw WebSocket handshake (plus a few bytes after it) through the web UI; what came back. */
function upgrade(port: number, pathname: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const h = {Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers};
      s.write(`GET ${pathname} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    });
    let got = '';
    s.on('data', (d) => {
      got += d.toString('latin1');
      if (got.includes('101 Switching') && !got.includes('ping-through')) s.write('ping-through');
      if (got.includes('ping-through') || /^HTTP\/1\.1 [45]/.test(got)) s.destroy();
    });
    s.on('close', () => resolve(got));
    setTimeout(() => s.destroy(), 4000);
  });
}

describe('previews streamed with Rein Remote', () => {
  it('proxies the stream only for this page, signed in, with the token the page never sees', async () => {
    saveWebConfig({mode: 'local', createdAt: Date.now()});
    const token = 'secret-token-123';
    const remote = await fakeRemote(token);
    process.env.FAKE_REMOTE = `${remote.port}:${token}`;
    const server = await startServer({port: 0, worker: () => ({command: process.execPath, args: [fixture]}), log: () => {}});
    closers.push(() => server.close());
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/chats`, {method: 'POST', headers: {'x-rein': '1', 'content-type': 'application/json'}, body: JSON.stringify({project: home})});
    const {id} = (await open.json()) as {id: string};
    const stream = `/api/chats/${id}/previews/1/stream`;

    // Another site's page (or no Origin at all) is refused before anything reaches rein-remote.
    expect(await upgrade(server.port, stream, {Origin: 'https://evil.example'})).toMatch(/^HTTP\/1\.1 403/);
    expect(await upgrade(server.port, stream, {})).toMatch(/^HTTP\/1\.1 403/);
    expect(remote.seen).toEqual([]);
    // This page: through to rein-remote with its token, and bytes go both ways.
    const ok = await upgrade(server.port, stream, {Origin: base});
    expect(ok).toMatch(/^HTTP\/1\.1 101/);
    expect(ok).toContain('ping-through');
    expect(remote.seen).toEqual([`/stream?token=${token}`]);
    // A preview without a stream, and a chat that isn't open: no.
    expect(await upgrade(server.port, `/api/chats/${id}/previews/2/stream`, {Origin: base})).toMatch(/^HTTP\/1\.1 502/);
    expect(await upgrade(server.port, '/api/chats/abc/previews/1/stream', {Origin: base})).toMatch(/^HTTP\/1\.1 404/);

    // The client script comes from that rein-remote; the page can't ask the worker for the token.
    const js = await fetch(`${base}/api/chats/${id}/previews/1/rein-remote.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await js.text()).toContain('rein-remote client');
    const peek = await fetch(`${base}/api/chats/${id}/request`, {method: 'POST', headers: {'x-rein': '1', 'content-type': 'application/json'}, body: JSON.stringify({op: 'remote-port', args: {id: 1}})});
    expect(peek.status).toBe(400);
    expect(await peek.text()).not.toContain(token);
  });

  it('refuses the stream to someone not signed in (password mode)', async () => {
    saveWebConfig({mode: 'password', createdAt: Date.now(), users: []});
    process.env.FAKE_REMOTE = '1:x';
    const server = await startServer({port: 0, host: '127.0.0.1', worker: () => ({command: process.execPath, args: [fixture]}), log: () => {}});
    closers.push(() => server.close());
    expect(await upgrade(server.port, '/api/chats/abc/previews/1/stream', {Origin: `http://127.0.0.1:${server.port}`})).toMatch(/^HTTP\/1\.1 401/);
  });

  it('finds the binary, and starts it with the token in its environment, not its arguments', async () => {
    expect(remoteBinary('off')).toBeUndefined();
    expect(remoteBinary(path.join(home, 'missing'))).toBeUndefined();
    const bin = path.join(home, 'rein-remote-stub.mjs');
    writeFileSync(bin, `#!${process.execPath}\nconsole.error('rein-remote: streaming a 640×480 screen on http://127.0.0.1:45678 (open it in a browser)');\nconsole.error('args=' + JSON.stringify(process.argv.slice(2)) + ' token=' + (process.env.REIN_REMOTE_TOKEN ? 'set' : 'unset'));\nsetInterval(() => {}, 1000);\n`);
    chmodSync(bin, 0o755);
    if (process.platform === 'win32') return; // a shebang script isn't a program there
    expect(remoteBinary(bin)).toBe(bin);
    const r = await startRemote(bin, 20);
    closers.push(() => r.stop());
    expect(r.port).toBe(45678);
    expect(r.token.length).toBeGreaterThan(20);
  });

  it("says so when it doesn't start", async () => {
    if (process.platform === 'win32') return;
    const bin = path.join(home, 'rein-remote-broken.mjs');
    writeFileSync(bin, `#!${process.execPath}\nconsole.error("rein-remote: can't open the X display :20: Connection refused");\nprocess.exit(1);\n`);
    chmodSync(bin, 0o755);
    await expect(startRemote(bin, 20)).rejects.toThrow(/can't open the X display/);
  });

  it("shows any app's window: lists them, picks one by name, streams it", async () => {
    if (process.platform === 'win32') return;
    const bin = path.join(home, 'rein-remote-win.mjs');
    writeFileSync(
      bin,
      `#!${process.execPath}
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'windows') console.log(JSON.stringify([{id: 41, app: 'Simulator', title: 'iPhone 16', width: 400, height: 860}, {id: 7, app: 'Calculator', title: '', width: 232, height: 320}]));
else if (cmd === 'serve') { console.error('args=' + rest.join(' ')); console.error('rein-remote: streaming a 400×860 screen on http://127.0.0.1:45679 (open it in a browser)'); setInterval(() => {}, 1000); }
`,
    );
    chmodSync(bin, 0o755);
    expect((await remoteWindows(bin)).map((w) => w.app)).toEqual(['Simulator', 'Calculator']);
    const previews = new Previews();
    const opened: number[] = [];
    const tool = previewTool(previews, (id) => opened.push(id), () => bin);
    const listed = await tool.run({} as never, {window: 'list'});
    expect(listed.text).toContain('41  Simulator — iPhone 16');
    const r = await tool.run({} as never, {window: 'iphone'});
    expect(r.ok).toBe(true);
    const p = previews.list()[0]!;
    closers.push(() => previews.stopAll());
    expect(p).toMatchObject({kind: 'window', target: '41', title: 'iPhone 16', remote: {port: 45679}});
    expect(opened).toEqual([p.id]);
    expect((await tool.run({} as never, {window: 'photoshop'})).text).toMatch(/No window matches "photoshop".*41 Simulator/);
    // Without rein-remote: says what it needs.
    const none = previewTool(new Previews(), () => {}, () => 'off');
    expect((await none.run({} as never, {window: 'iphone'})).text).toMatch(/needs Rein Remote/);
  });

  it('names the release build for each machine and reads SHA256SUMS', () => {
    expect(remoteTarget('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(remoteTarget('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(remoteTarget('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(remoteTarget('win32', 'arm64')).toBeUndefined();
    const h = 'a'.repeat(64);
    expect(parseSums(`${h}  rein-remote-v1-x.tar.gz\n${'b'.repeat(64)} *other.zip\n`)).toEqual(new Map([['rein-remote-v1-x.tar.gz', h], ['other.zip', 'b'.repeat(64)]]));
  });

  it('installs the release build only when it matches its SHA256SUMS', async () => {
    if (process.platform === 'win32') return;
    const {execFileSync} = await import('node:child_process');
    const {createHash} = await import('node:crypto');
    const {existsSync, mkdirSync, readFileSync} = await import('node:fs');
    const target = remoteTarget()!;
    const tag = 'v0.1.0';
    const name = `rein-remote-${tag}-${target}`;
    mkdirSync(path.join(home, 'pkg', name), {recursive: true});
    writeFileSync(path.join(home, 'pkg', name, 'rein-remote'), '#!/bin/sh\necho rein-remote 0.1.0\n');
    chmodSync(path.join(home, 'pkg', name, 'rein-remote'), 0o755);
    execFileSync('tar', ['czf', path.join(home, `${name}.tar.gz`), '-C', path.join(home, 'pkg'), name]);
    const archive = readFileSync(path.join(home, `${name}.tar.gz`));
    const serve = (sums: string) =>
      vi.fn(async (url: string) => {
        if (url.includes('/releases/latest')) return new Response(JSON.stringify({tag_name: tag, assets: [{name: `${name}.tar.gz`}, {name: 'SHA256SUMS'}]}));
        if (url.endsWith('/SHA256SUMS')) return new Response(sums);
        if (url.endsWith(`/${name}.tar.gz`)) return new Response(archive);
        return new Response('', {status: 404});
      });
    const good = `${createHash('sha256').update(archive).digest('hex')}  ${name}.tar.gz\n`;
    const dest = path.join(home, 'bin', 'rein-remote');
    // A tampered archive (the sums say otherwise): nothing is installed.
    vi.stubGlobal('fetch', serve(`${'0'.repeat(64)}  ${name}.tar.gz\n`));
    try {
      const bad = await installRemote();
      expect(bad.ok).toBe(false);
      expect(bad.text).toMatch(/doesn't match its SHA256SUMS/);
      expect(existsSync(dest)).toBe(false);
      vi.stubGlobal('fetch', serve(''));
      expect((await installRemote()).text).toMatch(/doesn't list/);
      vi.stubGlobal('fetch', serve(good));
      const ok = await installRemote();
      expect(ok).toMatchObject({ok: true});
      expect(execFileSync(dest).toString()).toContain('rein-remote 0.1.0');
      expect(remoteBinary('auto')).toBe(dest);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('streams a VNC preview with Rein Remote, the password in its environment', async () => {
    if (process.platform === 'win32') return;
    const log = path.join(home, 'vnc-args.json');
    const bin = path.join(home, 'rein-remote-vnc.mjs');
    writeFileSync(bin, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(log)}, JSON.stringify({args: process.argv.slice(2), pw: process.env.REIN_REMOTE_VNC_PASSWORD ?? null}));
console.error('rein-remote: streaming a 1024×640 screen on http://127.0.0.1:45680 (open it in a browser)');
setInterval(() => {}, 1000);
`);
    chmodSync(bin, 0o755);
    const previews = new Previews();
    const tool = previewTool(previews, () => {}, () => bin);
    const r = await tool.run({} as never, {vnc: ':30', password: 's3cret'});
    expect(r.ok).toBe(true);
    closers.push(() => previews.stopAll());
    const p = previews.list()[0]!;
    expect(p).toMatchObject({kind: 'vnc', target: 'localhost:5930', remote: {port: 45680}});
    const {readFileSync} = await import('node:fs');
    const seen = JSON.parse(readFileSync(log, 'utf8'));
    expect(seen.args).toEqual(['serve', '--vnc', 'localhost:5930', '--listen', '127.0.0.1:0', '--webtransport', 'off']);
    expect(seen.pw).toBe('s3cret');
    expect(seen.args.join(' ')).not.toContain('s3cret');
  });
});
