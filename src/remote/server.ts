import {randomBytes, randomInt, timingSafeEqual} from 'node:crypto';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {PAGE} from './page.js';

/**
 * Rein's remote page: watch the session, send messages and answer approvals from a phone or
 * another computer. Served by the running Rein itself (no hosted service), on localhost unless
 * you choose another address; reach it over Tailscale or a Cloudflare tunnel. A one-time pairing
 * code shown in Rein is traded for a random token: an HttpOnly cookie for reads, and a header the
 * page sends with every change (so another site can't make your browser post to it).
 */
export type RemoteMessage = {role: 'user' | 'assistant'; text: string; tools?: {label: string; summary: string; ok: boolean}[]};
export type RemoteApproval = {id: number; title: string; summary: string; preview: string; options: {decision: string; label: string}[]};
export type RemoteState = {project: string; model: string; busy: boolean; waitingUntil?: number; messages: RemoteMessage[]; live?: string; approval?: RemoteApproval};

export type RemoteDeps = {
  state(): RemoteState;
  send(text: string): void;
  approve(id: number, decision: string): boolean;
  interrupt(): void;
};

const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_BODY = 64 * 1024;
const COOKIE = 'rein_remote';

export class RemoteServer {
  private server: Server | undefined;
  private tokens = new Set<string>();
  private code: {value: string; expires: number; attempts: number} | undefined;
  private streams = new Set<ServerResponse>();
  /** Requests per client address in the current minute (pairing is the endpoint that matters). */
  private hits = new Map<string, {n: number; reset: number}>();

  constructor(private readonly deps: RemoteDeps) {}

  get running(): boolean {
    return !!this.server?.listening;
  }

  get address(): {host: string; port: number} | undefined {
    const a = this.server?.address() as AddressInfo | null | undefined;
    return a ? {host: a.address, port: a.port} : undefined;
  }

  get paired(): number {
    return this.tokens.size;
  }

  /** A fresh pairing code (6 digits, 5 minutes, 5 tries). */
  newCode(): string {
    const value = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = {value, expires: Date.now() + CODE_TTL_MS, attempts: 0};
    return value;
  }

  /** Forget every paired device. */
  unpairAll(): void {
    this.tokens.clear();
    for (const s of this.streams) s.end();
    this.streams.clear();
  }

  start(port: number, host: string): Promise<void> {
    if (this.server) return Promise.resolve();
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => this.reply(res, 500, {error: 'internal error'})));
    return new Promise((resolve, reject) => {
      this.server!.once('error', (err) => {
        this.server = undefined;
        reject(err);
      });
      this.server!.listen(port, host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const s of this.streams) s.end();
    this.streams.clear();
    const s = this.server;
    this.server = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** Something changed: tell every open page (it re-reads /api/state). Deltas carry the live reply text. */
  push(event: 'state' | 'delta', data: unknown = {}): void {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of this.streams) s.write(line);
  }

  private limited(req: IncomingMessage, perMinute: number): boolean {
    const ip = req.socket.remoteAddress ?? '?';
    const now = Date.now();
    const h = this.hits.get(ip);
    if (!h || h.reset < now) {
      this.hits.set(ip, {n: 1, reset: now + 60_000});
      return false;
    }
    h.n++;
    return h.n > perMinute;
  }

  private tokenOk(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const c = Buffer.from(candidate);
    for (const t of this.tokens) {
      const b = Buffer.from(t);
      if (b.length === c.length && timingSafeEqual(b, c)) return true;
    }
    return false;
  }

  private cookieToken(req: IncomingMessage): string | undefined {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie ?? '');
    return m?.[1];
  }

  private reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent) return void res.end();
    res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers});
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error('too big');
      chunks.push(c as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const security = {'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY'};
    if (this.limited(req, 600)) return this.reply(res, 429, {error: 'too many requests'});

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:", ...security});
      return void res.end(PAGE);
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      if (this.limited(req, 20)) return this.reply(res, 429, {error: 'too many tries, wait a minute'});
      const {code} = await this.body(req);
      const c = this.code;
      if (!c || Date.now() > c.expires) return this.reply(res, 403, {error: 'no pairing code is active: run /remote pair in Rein'});
      if (c.attempts >= MAX_ATTEMPTS) return this.reply(res, 403, {error: 'too many wrong codes: run /remote pair in Rein for a new one'});
      c.attempts++;
      const given = Buffer.from(String(code ?? ''));
      const want = Buffer.from(c.value);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return this.reply(res, 403, {error: `wrong code (${MAX_ATTEMPTS - c.attempts} tries left)`});
      this.code = undefined; // one device per code
      const token = randomBytes(32).toString('hex');
      this.tokens.add(token);
      return this.reply(res, 200, {token}, {...security, 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`});
    }

    // Everything else needs a paired device: the cookie for reads, the cookie and the header for changes.
    const cookie = this.cookieToken(req);
    if (!this.tokenOk(cookie)) return this.reply(res, 401, {error: 'not paired'});
    if (req.method === 'POST' && !this.tokenOk(String(req.headers['x-rein-token'] ?? '')) ) return this.reply(res, 401, {error: 'missing token header'});

    if (req.method === 'GET' && url.pathname === '/api/state') return this.reply(res, 200, this.deps.state(), security);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', ...security});
      res.write('event: state\ndata: {}\n\n');
      this.streams.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        this.streams.delete(res);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const {text} = await this.body(req);
      if (typeof text !== 'string' || !text.trim()) return this.reply(res, 400, {error: 'empty message'});
      this.deps.send(text.slice(0, 20_000));
      return this.reply(res, 200, {ok: true});
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const {id, decision} = await this.body(req);
      const ok = this.deps.approve(Number(id), String(decision));
      return this.reply(res, ok ? 200 : 409, ok ? {ok: true} : {error: 'that approval was already answered'});
    }
    if (req.method === 'POST' && url.pathname === '/api/interrupt') {
      this.deps.interrupt();
      return this.reply(res, 200, {ok: true});
    }
    return this.reply(res, 404, {error: 'not found'});
  }
}
