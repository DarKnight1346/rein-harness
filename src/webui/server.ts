import {existsSync, readFileSync, statSync} from 'node:fs';
import http, {type IncomingMessage, type ServerResponse} from 'node:http';
import https from 'node:https';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reinVersion} from '../commands/update.js';
import {listTranscripts} from '../session/transcript.js';
import {readJson, writeJson} from '../store/json.js';
import {reinHome} from '../store/paths.js';
import {run} from '../util/proc.js';
import {clearSetupCode, DEFAULT_PORT, findUser, hashPassword, hostAllowed, listenHost, loadWebConfig, LoginLimiter, sameSecret, saveWebConfig, Sessions, setupCode, type Mode, type WebConfig} from './auth.js';
import {Chats, type WorkerCommand} from './chats.js';
import * as fm from './files.js';

/**
 * `rein --ui`: Rein in the browser, on any of your devices. Chats run in worker processes
 * (chats.ts), one per conversation, in their project's folder; the page is plain HTML, CSS and JS
 * from webui/ (no build step). See auth.ts for who may use it.
 */
export type ServerOptions = {port?: number; host?: string; worker?: WorkerCommand; log?: (line: string) => void};

/** The web UI's files (webui/ at the package root), found by walking up from here. */
function assetsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'webui', 'index.html'))) return path.join(dir, 'webui');
    const up = path.dirname(dir);
    if (up === dir) throw new Error("the web UI's files are missing (webui/ next to Rein's package.json)");
    dir = up;
  }
}

const TYPES: Record<string, string> = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const recentsFile = () => path.join(reinHome(), 'webui-projects.json');

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const cookies = (req: IncomingMessage) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k!, decodeURIComponent(v!)]));
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store', ...headers});
  res.end(JSON.stringify(body));
};
async function body(req: IncomingMessage, max = 4 * 1024 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'request too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'not JSON');
  }
}

export async function startServer(opts: ServerOptions = {}): Promise<{url: string; port: number; close(): Promise<void>; setupCode?: string}> {
  const log = opts.log ?? ((l: string) => console.log(l));
  let config: WebConfig | undefined = loadWebConfig();
  const sessions = new Sessions();
  const limiter = new LoginLimiter();
  const worker: WorkerCommand = opts.worker ?? (() => ({command: process.execPath, args: [...process.execArgv, process.argv[1]!, '--ui-worker']}));
  const chats = new Chats(worker);
  const port = opts.port ?? DEFAULT_PORT;
  const host = listenHost(config, opts.host);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const assets = assetsDir();
  const require = createRequire(import.meta.url);
  const markedFile = path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.esm.js');

  const userOf = (req: IncomingMessage): string | undefined => {
    if (!config) return undefined;
    if (config.mode !== 'password') return 'you';
    return sessions.user(cookies(req).rein_session);
  };

  const recents = async (): Promise<string[]> => (await readJson<{projects?: string[]}>(recentsFile(), {}).catch((): {projects?: string[]} => ({}))).projects ?? [];
  const remember = async (dir: string) => writeJson(recentsFile(), {projects: [dir, ...(await recents()).filter((p) => p !== dir)].slice(0, 30)});

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const p = url.pathname;
    const m = req.method ?? 'GET';
    if (p === '/api/state' && m === 'GET') return json(res, 200, {version: reinVersion(), setup: !config, mode: config?.mode, user: userOf(req), home: os.homedir(), platform: process.platform});
    if (p === '/api/setup' && m === 'POST') {
      if (config) throw new HttpError(409, 'already set up');
      const b = await body(req);
      if (typeof b.code !== 'string' || !sameSecret(b.code.trim(), setupCode())) throw new HttpError(403, "that setup code isn't right: it's printed where rein --ui started, and kept in ~/.rein/webui-setup-code");
      const mode = b.mode as Mode;
      if (!['local', 'tailscale', 'password'].includes(mode)) throw new HttpError(400, 'pick a mode');
      const next: WebConfig = {mode, createdAt: Date.now()};
      if (mode === 'password') {
        const name = String(b.username ?? '').trim();
        if (!/^[\w.@-]{1,64}$/.test(name)) throw new HttpError(400, 'a username: letters, digits, . _ - @');
        if (String(b.password ?? '').length < 10) throw new HttpError(400, 'a password of at least 10 characters');
        next.users = [{name, ...hashPassword(String(b.password))}];
        next.host = '0.0.0.0';
      }
      saveWebConfig(next);
      config = next;
      clearSetupCode();
      let tailscale: string | undefined;
      if (mode === 'tailscale' && b.serve) {
        const r = await run('tailscale', ['serve', '--bg', String(port)], {timeoutMs: 30_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
        tailscale = r.code === 0 ? (r.stdout.match(/https:\/\/\S+/)?.[0] ?? 'on') : `couldn't start it: ${(r.stderr || r.stdout).trim().split('\n').pop()}`;
      }
      const headers: Record<string, string> = {};
      if (mode === 'password') headers['set-cookie'] = sessionCookie(req, sessions.create(next.users![0]!.name));
      const restart = mode === 'password' && loopback && !opts.host;
      return json(res, 200, {ok: true, mode, ...(tailscale ? {tailscale} : {}), ...(restart ? {restart: 'Restart rein --ui (or the service) to listen on your network, not just this computer.'} : {})}, headers);
    }
    if (!config) throw new HttpError(403, 'set up the web UI first');
    if (p === '/api/login' && m === 'POST') {
      const ip = req.socket.remoteAddress ?? '?';
      if (limiter.blocked(ip)) throw new HttpError(429, 'too many tries: wait 15 minutes');
      const b = await body(req);
      const u = config.mode === 'password' ? findUser(config, String(b.username ?? ''), String(b.password ?? '')) : undefined;
      if (!u) {
        limiter.fail(ip);
        throw new HttpError(401, 'wrong username or password');
      }
      limiter.clear(ip);
      return json(res, 200, {ok: true, user: u.name}, {'set-cookie': sessionCookie(req, sessions.create(u.name))});
    }
    if (p === '/api/logout' && m === 'POST') {
      sessions.end(cookies(req).rein_session);
      return json(res, 200, {ok: true}, {'set-cookie': 'rein_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'});
    }
    const user = userOf(req);
    if (!user) throw new HttpError(401, 'sign in');

    if (p === '/api/password' && m === 'POST') {
      if (config.mode !== 'password') throw new HttpError(400, 'there are no passwords in this mode');
      const b = await body(req);
      if (!findUser(config, user, String(b.current ?? ''))) throw new HttpError(403, "the current password isn't right");
      if (String(b.password ?? '').length < 10) throw new HttpError(400, 'a password of at least 10 characters');
      config = {...config, users: (config.users ?? []).map((u) => (u.name === user ? {name: u.name, ...hashPassword(String(b.password))} : u))};
      saveWebConfig(config);
      sessions.endAll();
      return json(res, 200, {ok: true}, {'set-cookie': sessionCookie(req, sessions.create(user))});
    }

    // Projects and their conversations.
    if (p === '/api/projects' && m === 'GET') {
      const saved = await listTranscripts({limit: 400});
      const fromChats = [...new Set(saved.map((s) => s.cwd).filter((c): c is string => !!c && existsSync(c)))];
      const all = [...new Set([...(await recents()), ...fromChats])].filter((d) => existsSync(d)).slice(0, 50);
      return json(res, 200, {projects: all.map((d) => ({path: d, name: path.basename(d) || d}))});
    }
    if (p === '/api/projects' && m === 'POST') {
      const b = await body(req);
      const dir = fm.resolvePath(b.path);
      if (!statSync(dir, {throwIfNoEntry: false})?.isDirectory()) throw new HttpError(400, `${dir} isn't a folder`);
      await remember(dir);
      return json(res, 200, {ok: true, path: dir});
    }
    if (p === '/api/chats' && m === 'GET') {
      const cwd = url.searchParams.get('project');
      const saved = await listTranscripts({...(cwd ? {cwd} : {}), limit: 200});
      const open = chats.list().filter((c) => !cwd || c.cwd === cwd);
      return json(res, 200, {
        open: open.map((c) => ({id: c.id, cwd: c.cwd, session: c.snapshot?.session, title: c.snapshot?.title ?? 'New chat', busy: c.busy, waiting: c.asks.size > 0})),
        saved: saved.map((s) => ({session: s.id, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, messages: s.messages})),
      });
    }
    if (p === '/api/chats' && m === 'POST') {
      const b = await body(req);
      const cwd = fm.resolvePath(b.project);
      if (!statSync(cwd, {throwIfNoEntry: false})?.isDirectory()) throw new HttpError(400, `${cwd} isn't a folder`);
      await remember(cwd);
      const c = chats.open(cwd, typeof b.resume === 'string' ? b.resume : undefined);
      await c.ready.catch(() => {});
      if (c.error) throw new HttpError(500, c.error);
      return json(res, 200, {id: c.id});
    }
    const chatRoute = p.match(/^\/api\/chats\/([\da-f]+)(?:\/(events|send|interrupt|answer|model|mode|compact|request|window))?$/);
    if (chatRoute) {
      const c = chats.get(chatRoute[1]!);
      if (!c) throw new HttpError(404, 'that chat is closed: open it again from the list');
      const action = chatRoute[2];
      c.lastSeen = Date.now();
      if (!action && m === 'DELETE') {
        chats.close(c.id);
        return json(res, 200, {ok: true});
      }
      if (action === 'events' && m === 'GET') {
        res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no'});
        const write = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (c.snapshot) write({type: 'snapshot', snapshot: c.snapshot});
        write({type: 'busy', busy: c.busy, ...(c.busy && c.phrase ? {phrase: c.phrase} : {})});
        for (const ev of c.backlog) write(ev);
        for (const a of c.asks.values()) write({type: 'ask', ...a});
        if (c.window) write({type: 'window', window: c.window});
        c.watchers++;
        const on = (ev: unknown) => write(ev);
        c.on('event', on);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        const done = () => {
          clearInterval(ping);
          c.off('event', on);
          c.watchers--;
          c.lastSeen = Date.now();
        };
        c.once('exit', () => res.end());
        req.on('close', done);
        return;
      }
      if (m !== 'POST') throw new HttpError(405, 'use POST');
      const b = await body(req);
      if (action === 'send') {
        if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'nothing to send');
        // While the agent works, a message is queued and a command (/btw, /cost…) runs now, as in the terminal.
        c.send(b.text);
      } else if (action === 'interrupt') c.interrupt();
      else if (action === 'answer') {
        if (!c.answer(Number(b.id), b.value)) throw new HttpError(404, 'already answered');
      } else if (action === 'model') c.setModel(String(b.model ?? 'auto'));
      else if (action === 'mode') c.setMode(String(b.mode ?? 'ask'));
      else if (action === 'compact') c.compact();
      else if (action === 'window') {
        c.window = undefined;
        return json(res, 200, {ok: true});
      } else if (action === 'request') {
        if (typeof b.op !== 'string' || !/^[a-z-]{1,32}$/.test(b.op)) throw new HttpError(400, 'which request?');
        const value = await c.request(b.op, b.args && typeof b.args === 'object' ? b.args : {}).catch((err: Error) => {
          throw new HttpError(400, err.message);
        });
        return json(res, 200, {value});
      }
      return json(res, 200, {ok: true});
    }

    // The file manager.
    if (p.startsWith('/api/fs/')) {
      const op = p.slice('/api/fs/'.length);
      const q = (k: string) => url.searchParams.get(k);
      if (op === 'roots' && m === 'GET') return json(res, 200, {roots: await fm.roots(), home: os.homedir()});
      if (op === 'list' && m === 'GET') return json(res, 200, await fm.list(fm.resolvePath(q('path') ?? '~'), q('hidden') === '1'));
      if (op === 'read' && m === 'GET') return json(res, 200, await fm.readText(fm.resolvePath(q('path'))));
      if (op === 'search' && m === 'GET') return json(res, 200, {results: await fm.search(fm.resolvePath(q('path')), q('q') ?? '', q('content') === '1', q('hidden') === '1')});
      if (op === 'raw' && m === 'GET') {
        const file = fm.resolvePath(q('path'));
        const st = statSync(file, {throwIfNoEntry: false});
        if (!st?.isFile()) throw new HttpError(404, `${file} isn't a file`);
        const name = path.basename(file);
        const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, {
          'content-type': q('download') === '1' ? 'application/octet-stream' : type,
          'content-length': String(st.size),
          'content-disposition': `${q('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
          // Served files never run as part of this page.
          'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        });
        fm.download(file).pipe(res);
        return;
      }
      if (op === 'upload' && m === 'POST') {
        const dest = await fm.upload(fm.resolvePath(q('dir')), q('name') ?? '', req, q('overwrite') === '1');
        return json(res, 200, {ok: true, path: dest});
      }
      if (m !== 'POST') throw new HttpError(405, 'use POST');
      const b = await body(req, op === 'write' ? 20 * 1024 * 1024 : undefined);
      if (op === 'write') await fm.writeText(fm.resolvePath(b.path), String(b.text ?? ''));
      else if (op === 'mkdir') await fm.mkdirp(fm.resolvePath(b.path));
      else if (op === 'move') await fm.move(fm.resolvePath(b.from), fm.resolvePath(b.to));
      else if (op === 'copy') await fm.copy(fm.resolvePath(b.from), fm.resolvePath(b.to));
      else if (op === 'delete') await fm.remove((Array.isArray(b.paths) ? b.paths : []).map(fm.resolvePath));
      else throw new HttpError(404, `no ${op}`);
      return json(res, 200, {ok: true});
    }
    throw new HttpError(404, `no ${p}`);
  }

  const sessionCookie = (req: IncomingMessage, token: string) => `rein_session=${token}; Path=/; Max-Age=${30 * 24 * 3600}; HttpOnly; SameSite=Strict${(req.socket as {encrypted?: boolean}).encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      // Without a login, only this computer's names (and Tailscale's) may reach it: a page on
      // another site can't point its domain at 127.0.0.1 and read it. Setup on a server you
      // started with --host is protected by the setup code instead.
      if (!hostAllowed(config, req.headers.host) && !(!config && !loopback)) throw new HttpError(403, `this address (${req.headers.host}) isn't allowed: open it as localhost`);
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          // Changes need a header another site's page can't send, and a matching Origin.
          if (req.headers['x-rein'] !== '1') throw new HttpError(403, 'missing X-Rein header');
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'cross-site request refused');
        }
        return await api(req, res, url);
      }
      // The page and its files.
      const file = url.pathname === '/' || !path.extname(url.pathname) ? 'index.html' : url.pathname.slice(1);
      const full = file === 'vendor/marked.js' ? markedFile : path.resolve(assets, file);
      if (full !== markedFile && !full.startsWith(assets + path.sep)) throw new HttpError(404, 'not found');
      if (!existsSync(full)) throw new HttpError(404, 'not found');
      res.writeHead(200, {'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': file === 'index.html' ? 'no-store' : 'no-cache'});
      res.end(readFileSync(full));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof fm.FileError ? err.status : 500;
      if (!res.headersSent) json(res, status, {error: (err as Error).message});
      else res.end();
    }
  };

  const server = config?.tls ? https.createServer({cert: readFileSync(config.tls.cert), key: readFileSync(config.tls.key)}, handler) : http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const actual = (server.address() as {port: number}).port;
  const shown = host === '0.0.0.0' || host === '::' ? os.hostname() : host === '127.0.0.1' ? 'localhost' : host;
  const url = `${config?.tls ? 'https' : 'http'}://${shown}:${actual}`;
  const code = config ? undefined : setupCode();
  log(config ? `Rein web UI: ${url} (${config.mode === 'password' ? 'sign in with your username and password' : config.mode === 'tailscale' ? 'this computer and your tailnet' : 'this computer only'})` : `Rein web UI: ${url}\nFirst run: open ${url}/?setup=${code} to set it up (setup code ${code}).`);
  return {
    url,
    port: actual,
    ...(code ? {setupCode: code} : {}),
    close: () =>
      new Promise((resolve) => {
        chats.closeAll();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
