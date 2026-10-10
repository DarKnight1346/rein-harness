import {createHash, randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {reinHome} from '../store/paths.js';

/**
 * Who may use the web UI. Three modes, chosen at first run:
 * - `local`: no login, and the server only listens on this computer (127.0.0.1).
 * - `tailscale`: no login, still on 127.0.0.1, reached from your other devices through
 *   `tailscale serve` (your tailnet is the lock).
 * - `password`: users and passwords, so it can run on a server of your own (any address).
 * Until setup is done, only the setup page answers, and it needs the one-time setup code Rein
 * prints when it starts: whoever reaches the page first can't claim the server.
 */
export type Mode = 'local' | 'tailscale' | 'password';
export type User = {name: string; salt: string; hash: string};
export type WebConfig = {mode: Mode; users?: User[]; host?: string; tls?: {cert: string; key: string}; createdAt: number};

export const DEFAULT_PORT = 9333;
const SESSION_MS = 30 * 24 * 3600_000;
const configFile = () => path.join(reinHome(), 'webui.json');
const setupFile = () => path.join(reinHome(), 'webui-setup-code');
const sessionsFile = () => path.join(reinHome(), 'webui-sessions.json');

const writePrivate = (f: string, s: string) => {
  mkdirSync(path.dirname(f), {recursive: true, mode: 0o700});
  writeFileSync(f, s, {mode: 0o600});
  try {
    chmodSync(f, 0o600);
  } catch {}
};

export function loadWebConfig(): WebConfig | undefined {
  try {
    const c = JSON.parse(readFileSync(configFile(), 'utf8'));
    return c && ['local', 'tailscale', 'password'].includes(c.mode) ? c : undefined;
  } catch {
    return undefined;
  }
}
export const saveWebConfig = (c: WebConfig) => writePrivate(configFile(), JSON.stringify(c, null, 2) + '\n');

/** The one-time setup code (made on first use; gone once setup is done). */
export function setupCode(): string {
  if (existsSync(setupFile())) return readFileSync(setupFile(), 'utf8').trim();
  const code = randomBytes(9).toString('base64url');
  writePrivate(setupFile(), code + '\n');
  return code;
}
export const clearSetupCode = () => rmSync(setupFile(), {force: true});

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): {salt: string; hash: string} {
  return {salt, hash: scryptSync(password, salt, 32).toString('hex')};
}
export function checkPassword(u: User, password: string): boolean {
  const a = Buffer.from(hashPassword(password, u.salt).hash, 'hex');
  const b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Same time whether or not the user exists. */
export function findUser(c: WebConfig, name: string, password: string): User | undefined {
  const u = c.users?.find((x) => x.name === name);
  const ok = checkPassword(u ?? {name: '', ...hashPassword('x')}, password);
  return u && ok ? u : undefined;
}

export function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** Login sessions: a random token in an HttpOnly cookie; only its hash is kept (and saved, so a restart keeps you signed in). */
export class Sessions {
  private byHash = new Map<string, {user: string; expires: number}>();
  constructor() {
    try {
      for (const [h, s] of Object.entries<any>(JSON.parse(readFileSync(sessionsFile(), 'utf8')))) if (s.expires > Date.now()) this.byHash.set(h, s);
    } catch {}
  }
  private save() {
    writePrivate(sessionsFile(), JSON.stringify(Object.fromEntries(this.byHash)));
  }
  private static hash = (t: string) => createHash('sha256').update(t).digest('hex');
  create(user: string): string {
    const token = randomBytes(32).toString('base64url');
    this.byHash.set(Sessions.hash(token), {user, expires: Date.now() + SESSION_MS});
    this.save();
    return token;
  }
  user(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const s = this.byHash.get(Sessions.hash(token));
    return s && s.expires > Date.now() ? s.user : undefined;
  }
  end(token: string | undefined): void {
    if (token && this.byHash.delete(Sessions.hash(token))) this.save();
  }
  endAll(): void {
    this.byHash.clear();
    this.save();
  }
}

/** Failed logins per address: 5 within 15 minutes and that address waits. */
export class LoginLimiter {
  private fails = new Map<string, number[]>();
  constructor(private readonly max = 5, private readonly windowMs = 15 * 60_000) {}
  blocked(ip: string): boolean {
    const recent = (this.fails.get(ip) ?? []).filter((t) => Date.now() - t < this.windowMs);
    this.fails.set(ip, recent);
    return recent.length >= this.max;
  }
  fail(ip: string): void {
    this.fails.set(ip, [...(this.fails.get(ip) ?? []), Date.now()]);
  }
  clear(ip: string): void {
    this.fails.delete(ip);
  }
}

/** Where the server listens: local and tailscale modes (and setup) only on this computer. */
export const listenHost = (c: WebConfig | undefined, flag?: string) => flag ?? (c?.mode === 'password' ? (c.host ?? '0.0.0.0') : '127.0.0.1');

/**
 * Host header check for the modes without a login: a page on another site can't reach a server on
 * 127.0.0.1 by pointing its own domain at it (DNS rebinding). Tailscale's names (*.ts.net) pass.
 */
export function hostAllowed(c: WebConfig | undefined, host: string | undefined): boolean {
  if (c?.mode === 'password') return true;
  const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost') || (c?.mode === 'tailscale' && h.endsWith('.ts.net'));
}
