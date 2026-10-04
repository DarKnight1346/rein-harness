import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, statSync, readdirSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {callbackServer} from '../src/mcp/oauth.js';

vi.setConfig({testTimeout: 30_000});

describe('OAuth callback server', () => {
  it('returns the code when the state matches, and rejects a mismatched state', async () => {
    const ok = await callbackServer(0, 'state-1');
    await fetch(`http://127.0.0.1:${ok.port}/callback?code=abc&state=state-1`);
    expect(await ok.code).toBe('abc');
    const bad = await callbackServer(0, 'state-1');
    void fetch(`http://127.0.0.1:${bad.port}/callback?code=abc&state=forged`);
    await expect(bad.code).rejects.toThrow(/did not match/);
  });
});

// End to end against the MCP SDK's own demo OAuth server (dynamic registration, PKCE, auto-approve).
describe('MCP OAuth sign-in (SDK demo server)', () => {
  let server: ChildProcess;
  const port = 34000 + Math.floor(Math.random() * 1000);
  beforeAll(async () => {
    const demo = path.resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/examples/server/simpleStreamableHttp.js');
    server = spawn(process.execPath, [demo, '--oauth'], {env: {...process.env, MCP_PORT: String(port), MCP_AUTH_PORT: String(port + 1)}, stdio: ['ignore', 'pipe', 'pipe']});
    await new Promise<void>((resolve) => {
      let seen = '';
      server.stdout!.on('data', (d) => {
        seen += d;
        if (seen.includes(`listening on port ${port}`)) resolve();
      });
    });
  });
  afterAll(() => server?.kill());

  it('shows "sign in", completes the browser flow, saves tokens owner-only, and reuses them', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'rein-oauth-'));
    Object.assign(process.env, {REIN_HOME: home, REIN_NO_BROWSER: '1', REIN_CLAUDE_JSON: path.join(home, 'none.json')});
    writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({mcpServers: {demo: {type: 'http', url: `http://localhost:${port}/mcp`}}}));
    const {McpManager} = await import('../src/mcp/manager.js');
    const m = new McpManager(mkdtempSync(path.join(os.tmpdir(), 'rein-proj-')));
    await m.start();
    expect(m.list()[0]).toMatchObject({name: 'demo', status: 'needs-auth'});
    // The "browser": follow the authorization URL; the demo server approves and redirects back.
    await m.signIn('demo', (url) => void fetch(url, {redirect: 'follow'}).catch(() => {}));
    expect(m.list()[0]).toMatchObject({status: 'connected'});
    expect(m.list()[0]!.toolNames).toContain('greet');
    const file = readdirSync(path.join(home, 'mcp-auth'))[0]!;
    if (process.platform !== 'win32') expect(statSync(path.join(home, 'mcp-auth', file)).mode & 0o777).toBe(0o600);
    await m.closeAll();
    const again = new McpManager(mkdtempSync(path.join(os.tmpdir(), 'rein-proj-')));
    await again.start();
    expect(again.list()[0]).toMatchObject({status: 'connected'}); // saved tokens, no sign-in
    await again.closeAll();
  });
});
