import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {checkPassword, hashPassword, hostAllowed, listenHost, LoginLimiter, saveWebConfig, Sessions} from '../src/webui/auth.js';
import {startServer} from '../src/webui/server.js';
import {installService, launchdPlist, systemdUnit, uninstallService} from '../src/webui/service.js';
import {eventView, messageView} from '../src/webui/worker.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-webui-worker.mjs');
let home: string;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
const saved = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-webui-'));
  process.env.REIN_HOME = home;
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (saved === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = saved;
});

const start = async () => (server = await startServer({port: 0, worker: () => ({command: process.execPath, args: [fixture]}), log: () => {}}));
const call = (path_: string, opts: {method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string} = {}) =>
  fetch(`http://127.0.0.1:${server!.port}${path_}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {'x-rein': '1', 'content-type': 'application/json', ...(opts.cookie ? {cookie: opts.cookie} : {}), ...opts.headers},
    ...(opts.body !== undefined ? {body: JSON.stringify(opts.body)} : {}),
  });

/** Server-sent events of a chat until `until` matches one (or a few seconds pass). */
async function events(id: string, until: (ev: any) => boolean): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${server!.port}/api/chats/${id}/events`);
  const reader = res.body!.getReader();
  const out: any[] = [];
  let buf = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const {value, done} = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      const ev = JSON.parse(chunk.slice(6));
      out.push(ev);
      if (until(ev)) {
        await reader.cancel();
        return out;
      }
    }
  }
  await reader.cancel();
  return out;
}

describe('web UI access', () => {
  it('hashes passwords, keeps sessions, and limits failed sign-ins', () => {
    const u = {name: 'me', ...hashPassword('correct horse')};
    expect(checkPassword(u, 'correct horse')).toBe(true);
    expect(checkPassword(u, 'wrong')).toBe(false);
    const s = new Sessions();
    const t = s.create('me');
    expect(new Sessions().user(t)).toBe('me'); // kept across a restart (hashed)
    expect(readFileSync(path.join(home, 'webui-sessions.json'), 'utf8')).not.toContain(t);
    s.end(t);
    expect(s.user(t)).toBeUndefined();
    const l = new LoginLimiter(3);
    for (let i = 0; i < 3; i++) l.fail('1.2.3.4');
    expect(l.blocked('1.2.3.4')).toBe(true);
    expect(l.blocked('5.6.7.8')).toBe(false);
  });

  it('listens on this computer only without a login, and checks the Host header', () => {
    expect(listenHost(undefined)).toBe('127.0.0.1');
    expect(listenHost({mode: 'local', createdAt: 0})).toBe('127.0.0.1');
    expect(listenHost({mode: 'tailscale', createdAt: 0})).toBe('127.0.0.1');
    expect(listenHost({mode: 'password', createdAt: 0})).toBe('0.0.0.0');
    expect(listenHost({mode: 'local', createdAt: 0}, '10.0.0.5')).toBe('10.0.0.5');
    expect(hostAllowed({mode: 'local', createdAt: 0}, 'localhost:9333')).toBe(true);
    expect(hostAllowed({mode: 'local', createdAt: 0}, 'evil.example')).toBe(false); // DNS rebinding
    expect(hostAllowed({mode: 'local', createdAt: 0}, 'mac.tail1234.ts.net')).toBe(false);
    expect(hostAllowed({mode: 'tailscale', createdAt: 0}, 'mac.tail1234.ts.net')).toBe(true);
    expect(hostAllowed({mode: 'password', createdAt: 0}, 'rein.example.com')).toBe(true);
  });

  it('sets up with the one-time code, then refuses cross-site and header-less changes', async () => {
    await start();
    expect(server!.setupCode).toBeTruthy();
    expect(await (await call('/api/state')).json()).toMatchObject({setup: true});
    expect((await call('/api/projects')).status).toBe(403); // nothing else before setup
    expect((await call('/api/setup', {body: {code: 'nope', mode: 'local'}})).status).toBe(403);
    expect((await call('/api/setup', {body: {code: server!.setupCode, mode: 'local'}, headers: {'x-rein': ''}})).status).toBe(403);
    expect((await call('/api/setup', {body: {code: server!.setupCode, mode: 'local'}, headers: {origin: 'http://evil.example'}})).status).toBe(403);
    const ok = await call('/api/setup', {body: {code: server!.setupCode, mode: 'local'}});
    expect(await ok.json()).toMatchObject({ok: true, mode: 'local'});
    expect(existsSync(path.join(home, 'webui-setup-code'))).toBe(false); // used up
    expect((await call('/api/setup', {body: {code: server!.setupCode, mode: 'local'}})).status).toBe(409);
    expect(await (await call('/api/state')).json()).toMatchObject({setup: false, mode: 'local', user: 'you'});
    // The page itself, with a strict content security policy.
    const page = await call('/');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('<div id="app">');
    expect((await call('/vendor/marked.js')).status).toBe(200);
    expect((await call('/../package.json')).status).toBe(404);
  });

  it('asks for a password in password mode, and locks out guessing', async () => {
    saveWebConfig({mode: 'password', users: [{name: 'gary', ...hashPassword('a long password')}], createdAt: 0});
    await start();
    expect((await call('/api/projects')).status).toBe(401);
    expect((await call('/api/login', {body: {username: 'gary', password: 'wrong'}})).status).toBe(401);
    const res = await call('/api/login', {body: {username: 'gary', password: 'a long password'}});
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await call('/api/projects', {cookie: cookie.split(';')[0]})).status).toBe(200);
    for (let i = 0; i < 5; i++) await call('/api/login', {body: {username: 'gary', password: 'guess'}});
    expect((await call('/api/login', {body: {username: 'gary', password: 'a long password'}})).status).toBe(429);
  });
});

describe('web UI chats', () => {
  it('opens a chat in a project, streams the reply, and takes an approval from the page', async () => {
    saveWebConfig({mode: 'local', createdAt: 0});
    await start();
    const project = path.join(home, 'proj');
    mkdirSync(project);
    expect((await call('/api/chats', {body: {project: path.join(home, 'nope')}})).status).toBe(400);
    const {id} = await (await call('/api/chats', {body: {project}})).json();
    expect(id).toMatch(/^[\da-f]{16}$/);
    const first = events(id, (ev) => ev.type === 'snapshot' && ev.snapshot.messages.length === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect((await call(`/api/chats/${id}/send`, {body: {text: 'hello'}})).status).toBe(200);
    const evs = await first;
    expect(evs.map((e) => e.type)).toEqual(expect.arrayContaining(['snapshot', 'busy', 'user', 'text']));
    expect(evs.at(-1).snapshot.messages.at(-1).text).toBe('echo: hello');
    // An approval: shown to whoever is watching (and to a page that connects later), answered once.
    const second = events(id, (ev) => ev.type === 'ask');
    await new Promise((r) => setTimeout(r, 200));
    await call(`/api/chats/${id}/send`, {body: {text: 'please approve this'}});
    const ask = (await second).find((e) => e.type === 'ask');
    expect(ask).toMatchObject({kind: 'approval', payload: {tool: 'Edit'}});
    const late = await events(id, (ev) => ev.type === 'ask');
    expect(late.some((e) => e.type === 'ask')).toBe(true);
    expect((await call(`/api/chats/${id}/answer`, {body: {id: ask.id, value: 'once'}})).status).toBe(200);
    expect((await call(`/api/chats/${id}/answer`, {body: {id: ask.id, value: 'once'}})).status).toBe(404);
    // The project is remembered; the chat shows as open.
    expect((await (await call('/api/projects')).json()).projects.map((p: any) => p.path)).toContain(project);
    const list = await (await call(`/api/chats?project=${encodeURIComponent(project)}`)).json();
    expect(list.open[0]).toMatchObject({id, title: 'hello'});
    await call(`/api/chats/${id}`, {method: 'DELETE'});
    expect((await call(`/api/chats/${id}/send`, {body: {text: 'x'}})).status).toBe(404);
  });

  it('turns engine events and messages into what the page shows', () => {
    const label = () => 'Sonnet';
    expect(eventView({type: 'text', delta: 'hi'}, label)).toEqual({type: 'text', delta: 'hi'});
    expect(eventView({type: 'tool', activity: {phase: 'end', id: 1, label: 'Shell', summary: '$ ls', ok: true, result: 'x'.repeat(9000)}}, label)).toMatchObject({type: 'tool', phase: 'end', ok: true});
    expect((eventView({type: 'tool', activity: {phase: 'end', id: 1, label: 'Shell', summary: '$ ls', ok: true, result: 'x'.repeat(9000)}}, label) as any).result.length).toBeLessThan(8200);
    expect(eventView({type: 'tool', activity: {phase: 'start', id: 2, label: 'Read', summary: 'a', origin: {agent: 1} as any}}, label)).toBeUndefined(); // a subagent's
    expect(messageView({role: 'assistant', text: 'ok', at: 1, tools: [{label: 'Edit', summary: 'a.ts', ok: true, result: 'done'}]}).tools![0]).toMatchObject({label: 'Edit', ok: true});
  });
});

describe('web UI file manager', () => {
  it('lists, reads, writes, uploads, renames, copies, deletes and searches', async () => {
    saveWebConfig({mode: 'local', createdAt: 0});
    await start();
    const dir = path.join(home, 'files');
    mkdirSync(path.join(dir, 'sub'), {recursive: true});
    writeFileSync(path.join(dir, '.hidden'), 'h');
    const q = (p: string) => encodeURIComponent(p);
    expect((await call('/api/fs/write', {body: {path: path.join(dir, 'a.txt'), text: 'hello world'}})).status).toBe(200);
    const listed = await (await call(`/api/fs/list?path=${q(dir)}`)).json();
    expect(listed.entries.map((e: any) => [e.name, e.dir])).toEqual([['sub', true], ['a.txt', false]]);
    expect((await (await call(`/api/fs/list?path=${q(dir)}&hidden=1`)).json()).entries).toHaveLength(3);
    expect(await (await call(`/api/fs/read?path=${q(path.join(dir, 'a.txt'))}`)).json()).toMatchObject({text: 'hello world'});
    expect(await (await call(`/api/fs/raw?path=${q(path.join(dir, 'a.txt'))}`)).text()).toBe('hello world');
    // Upload: a raw body, never over an existing file unless asked.
    const up = (name: string, extra = '') => fetch(`http://127.0.0.1:${server!.port}/api/fs/upload?dir=${q(dir)}&name=${q(name)}${extra}`, {method: 'POST', headers: {'x-rein': '1'}, body: 'uploaded'});
    expect((await up('b.bin')).status).toBe(200);
    expect((await up('b.bin')).status).toBe(409);
    expect((await up('b.bin', '&overwrite=1')).status).toBe(200);
    expect((await up('../escape')).status).toBe(400);
    expect((await call('/api/fs/move', {body: {from: path.join(dir, 'b.bin'), to: path.join(dir, 'sub', 'c.bin')}})).status).toBe(200);
    expect((await call('/api/fs/copy', {body: {from: path.join(dir, 'sub'), to: path.join(dir, 'sub2')}})).status).toBe(200);
    expect(readFileSync(path.join(dir, 'sub2', 'c.bin'), 'utf8')).toBe('uploaded');
    expect((await call('/api/fs/move', {body: {from: path.join(dir, 'sub'), to: path.join(dir, 'sub', 'inside')}})).status).toBe(400);
    expect((await call('/api/fs/mkdir', {body: {path: path.join(dir, 'new')}})).status).toBe(200);
    expect((await call('/api/fs/mkdir', {body: {path: path.join(dir, 'new')}})).status).toBe(409);
    const found = await (await call(`/api/fs/search?path=${q(dir)}&q=world&content=1`)).json();
    expect(found.results.map((r: any) => path.basename(r.path))).toEqual(['a.txt']);
    expect((await call('/api/fs/delete', {body: {paths: [path.join(dir, 'sub2')]}})).status).toBe(200);
    expect(existsSync(path.join(dir, 'sub2'))).toBe(false);
    expect((await call('/api/fs/delete', {body: {paths: [os.homedir()]}})).status).toBe(400);
    expect((await call('/api/fs/list?path=relative/path')).status).toBe(400);
  });
});

describe('rein service', () => {
  it('writes a launchd agent, a systemd user unit or a scheduled task, with your PATH', async () => {
    const plist = launchdPlist(['/usr/bin/node', '/opt/rein/cli.js', '--ui', '--port', '9333'], {PATH: '/a:/b & c'}, '/tmp/log');
    expect(plist).toContain('<string>--ui</string>');
    expect(plist).toContain('/a:/b &amp; c');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    const unit = systemdUnit(['/usr/bin/node', '/opt/my rein/cli.js', '--ui'], {PATH: '/a'}, '/tmp/log');
    expect(unit).toContain('ExecStart=/usr/bin/node "/opt/my rein/cli.js" --ui');
    expect(unit).toContain('WantedBy=default.target');
    const calls: string[] = [];
    const exec = async (cmd: string, args: string[]) => (calls.push(`${cmd} ${args.join(' ')}`), {code: 0, stdout: '', stderr: ''});
    const fakeHome = path.join(home, 'h');
    expect((await installService({port: 9444, exec, home: fakeHome, platform: 'darwin'}))[0]).toMatch(/on port 9444/);
    expect(readFileSync(path.join(fakeHome, 'Library/LaunchAgents/dev.rein.webui.plist'), 'utf8')).toContain('<string>9444</string>');
    expect(calls.some((c) => c.startsWith('launchctl bootstrap'))).toBe(true);
    expect(await uninstallService({exec, home: fakeHome, platform: 'darwin'})).toMatch(/Removed/);
    calls.length = 0;
    await installService({exec, home: fakeHome, platform: 'win32'});
    expect(calls[0]).toMatch(/^schtasks \/Create \/TN Rein Web UI \/SC ONLOGON/);
    const noSystemd = async () => ({code: 1, stdout: '', stderr: 'not found'});
    await expect(installService({exec: noSystemd, home: fakeHome, platform: 'linux'})).rejects.toThrow(/no systemd user session/);
  });
});
