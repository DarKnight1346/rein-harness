import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer, type Server as HttpServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import path from 'node:path';
import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens} from '@modelcontextprotocol/sdk/shared/auth.js';
import {writeFileSecure} from '../store/json.js';
import {reinHome} from '../store/paths.js';

/**
 * OAuth for remote MCP servers (Linear, Notion, Atlassian, Sentry, GitHub's hosted server…), per
 * the MCP authorization spec: dynamic client registration + authorization code with PKCE, handled
 * by the MCP SDK. Rein supplies storage (`~/.rein/mcp-auth/<host>_<path>.json`, owner-only) and the
 * browser round trip: a one-shot callback server on 127.0.0.1. Signing in is always the user's
 * action (/mcp); background connects never open a browser.
 */
type Stored = {client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; port?: number};

/**
 * Where a server is (protocol, host, path), without credentials or query parameters a URL might
 * carry: the identity its tokens are stored under.
 */
export function serverKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0]!.replace(/\/\/[^/@]*@/, '//');
  }
}
/** `~/.rein/mcp-auth/mcp.linear.app_mcp.json`: readable, so it's clear which file signs you out. */
const authFile = (url: string) => path.join(reinHome(), 'mcp-auth', `${serverKey(url).replace(/^[a-z]+:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'server'}.json`);

export class ReinOAuthProvider implements OAuthClientProvider {
  private data: Stored;
  /** Set during an interactive sign-in: where to send the browser. */
  private onRedirect?: (url: URL) => void;
  private stateValue = randomBytes(16).toString('hex');

  constructor(private readonly url: string, private readonly serverName: string) {
    try {
      this.data = JSON.parse(readFileSync(authFile(url), 'utf8')) as Stored;
    } catch {
      this.data = {};
    }
  }

  private save(): Promise<void> {
    return writeFileSecure(authFile(this.url), JSON.stringify(this.data, null, 2));
  }

  /** The loopback port this server's client was registered with (kept stable for re-auth). */
  get port(): number | undefined {
    return this.data.port;
  }
  setPort(port: number): void {
    this.data.port = port;
  }

  get redirectUrl(): string | undefined {
    return this.data.port ? `http://127.0.0.1:${this.data.port}/callback` : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `Rein (${this.serverName})`,
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation() {
    return this.data.client;
  }
  async saveClientInformation(info: OAuthClientInformationMixed) {
    this.data.client = info;
    await this.save();
  }
  tokens() {
    return this.data.tokens;
  }
  async saveTokens(tokens: OAuthTokens) {
    this.data.tokens = tokens;
    await this.save();
  }
  async saveCodeVerifier(verifier: string) {
    this.data.verifier = verifier;
    await this.save();
  }
  codeVerifier() {
    if (!this.data.verifier) throw new Error('no PKCE code verifier saved');
    return this.data.verifier;
  }

  /** Background connect: no browser; the server shows "sign in" in /mcp instead. */
  redirectToAuthorization(url: URL) {
    this.onRedirect?.(url);
  }

  interactive(onRedirect: ((url: URL) => void) | undefined): void {
    this.onRedirect = onRedirect;
  }

  /** Forget everything for this server (sign out). */
  async clear(): Promise<void> {
    this.data = {port: this.data.port};
    await this.save();
  }

  get hasTokens(): boolean {
    return !!this.data.tokens;
  }
}

/**
 * A one-shot loopback server for the OAuth redirect: resolves with the authorization code (or
 * rejects on an error or after `timeoutMs`). `port` 0 picks a free port; read it from `.port`.
 */
export async function callbackServer(port: number, expectedState: string, timeoutMs = 5 * 60_000): Promise<{port: number; code: Promise<string>; close(): void}> {
  let server!: HttpServer;
  let settle!: {resolve(code: string): void; reject(err: Error): void};
  const code = new Promise<string>((resolve, reject) => (settle = {resolve, reject}));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const got = url.searchParams.get('code');
    const ok = !error && got && url.searchParams.get('state') === expectedState;
    res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
    res.end(`<!doctype html><meta charset="utf-8"><title>Rein</title><body style="font-family:system-ui;background:#0b0b0f;color:#eee;display:grid;place-items:center;height:100vh"><div><h2>${ok ? 'Signed in — you can close this tab and go back to Rein.' : 'Sign-in failed'}</h2>${ok ? '' : `<p>${(error ?? 'unexpected response').replace(/[<>&]/g, '')}</p>`}</div></body>`);
    if (ok) settle.resolve(got!);
    else settle.reject(new Error(error ? `the server refused: ${error}` : 'the sign-in response did not match (state)'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const timer = setTimeout(() => settle.reject(new Error('timed out waiting for the browser sign-in')), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  void code.finally(close).catch(() => {});
  return {port: (server.address() as AddressInfo).port, code, close};
}
