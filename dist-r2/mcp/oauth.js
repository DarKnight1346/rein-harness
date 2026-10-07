import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { writeFileSecure } from '../store/json.js';
import { reinHome } from '../store/paths.js';
/**
 * Where a server is (protocol, host, path), without credentials or query parameters a URL might
 * carry: the identity its tokens are stored under.
 */
export function serverKey(url) {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}`;
    }
    catch {
        return url.split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//');
    }
}
/** `~/.rein/mcp-auth/mcp.linear.app_mcp.json`: readable, so it's clear which file signs you out. */
const authFile = (url) => path.join(reinHome(), 'mcp-auth', `${serverKey(url).replace(/^[a-z]+:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'server'}.json`);
export class ReinOAuthProvider {
    url;
    serverName;
    data;
    /** Set during an interactive sign-in: where to send the browser. */
    onRedirect;
    stateValue = randomBytes(16).toString('hex');
    constructor(url, serverName) {
        this.url = url;
        this.serverName = serverName;
        try {
            this.data = JSON.parse(readFileSync(authFile(url), 'utf8'));
        }
        catch {
            this.data = {};
        }
    }
    save() {
        return writeFileSecure(authFile(this.url), JSON.stringify(this.data, null, 2));
    }
    /** The loopback port this server's client was registered with (kept stable for re-auth). */
    get port() {
        return this.data.port;
    }
    setPort(port) {
        this.data.port = port;
    }
    get redirectUrl() {
        return this.data.port ? `http://127.0.0.1:${this.data.port}/callback` : undefined;
    }
    get clientMetadata() {
        return {
            client_name: `Rein (${this.serverName})`,
            redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        };
    }
    state() {
        return this.stateValue;
    }
    clientInformation() {
        return this.data.client;
    }
    async saveClientInformation(info) {
        this.data.client = info;
        await this.save();
    }
    tokens() {
        return this.data.tokens;
    }
    async saveTokens(tokens) {
        this.data.tokens = tokens;
        await this.save();
    }
    async saveCodeVerifier(verifier) {
        this.data.verifier = verifier;
        await this.save();
    }
    codeVerifier() {
        if (!this.data.verifier)
            throw new Error('no PKCE code verifier saved');
        return this.data.verifier;
    }
    /** Background connect: no browser; the server shows "sign in" in /mcp instead. */
    redirectToAuthorization(url) {
        this.onRedirect?.(url);
    }
    interactive(onRedirect) {
        this.onRedirect = onRedirect;
    }
    /** Forget everything for this server (sign out). */
    async clear() {
        this.data = { port: this.data.port };
        await this.save();
    }
    get hasTokens() {
        return !!this.data.tokens;
    }
}
/**
 * A one-shot loopback server for the OAuth redirect: resolves with the authorization code (or
 * rejects on an error or after `timeoutMs`). `port` 0 picks a free port; read it from `.port`.
 */
export async function callbackServer(port, expectedState, timeoutMs = 5 * 60_000) {
    let server;
    let settle;
    const code = new Promise((resolve, reject) => (settle = { resolve, reject }));
    server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
            res.writeHead(404).end();
            return;
        }
        const error = url.searchParams.get('error');
        const got = url.searchParams.get('code');
        const ok = !error && got && url.searchParams.get('state') === expectedState;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Rein</title><body style="font-family:system-ui;background:#0b0b0f;color:#eee;display:grid;place-items:center;height:100vh"><div><h2>${ok ? 'Signed in — you can close this tab and go back to Rein.' : 'Sign-in failed'}</h2>${ok ? '' : `<p>${(error ?? 'unexpected response').replace(/[<>&]/g, '')}</p>`}</div></body>`);
        if (ok)
            settle.resolve(got);
        else
            settle.reject(new Error(error ? `the server refused: ${error}` : 'the sign-in response did not match (state)'));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
    const timer = setTimeout(() => settle.reject(new Error('timed out waiting for the browser sign-in')), timeoutMs);
    const close = () => {
        clearTimeout(timer);
        server.close();
    };
    void code.finally(close).catch(() => { });
    return { port: server.address().port, code, close };
}
