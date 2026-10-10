import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {saveWebConfig} from '../src/webui/auth.js';
import {startServer} from '../src/webui/server.js';

// The real chat worker (rein --ui-worker, from source): slash commands, windows and the status
// line go through the same code as the terminal's. No account, so nothing reaches a model.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = () => ({command: process.execPath, args: [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'src/cli.ts'), '--ui-worker']});

let home: string;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
const saved = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-webcmd-'));
  process.env.REIN_HOME = home;
  writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({version: 1, importOffered: true, accounts: []}));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (saved === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = saved;
});

const call = async (p: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${server!.port}${p}`, {method: body === undefined ? 'GET' : 'POST', headers: {'x-rein': '1', 'content-type': 'application/json'}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  return {status: res.status, json: await res.json().catch(() => undefined)};
};

/** The chat's events until `until` matches one. */
async function events(id: string, until: (ev: any) => boolean): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${server!.port}/api/chats/${id}/events`);
  const reader = res.body!.getReader();
  const out: any[] = [];
  let buf = '';
  const deadline = Date.now() + 20_000;
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

describe('web UI commands (the real worker)', () => {
  it('runs slash commands, opens /settings and /model, saves settings, and sends the status line and sidebar', async () => {
    saveWebConfig({mode: 'local', createdAt: 0});
    server = await startServer({port: 0, worker, log: () => {}});
    const project = path.join(home, 'proj');
    mkdirSync(project);
    const {json} = await call('/api/chats', {project});
    const id = json.id as string;
    const ask = async (op: string, args: object) => (await call(`/api/chats/${id}/request`, {op, args})).json;

    // The / list: the terminal's, ranked the same way.
    const bare = (await ask('suggest', {text: '/'})).value.map((c: any) => c.name);
    expect(bare.slice(0, 2)).toEqual(['model', 'goal']);
    expect(bare).not.toContain('tui'); // left out of a bare list, as in the terminal
    expect((await ask('suggest', {text: '/sett'})).value[0].name).toBe('settings');

    // A command prints into the thread: its echo, then its output.
    let evs = events(id, (ev) => ev.type === 'log');
    await new Promise((r) => setTimeout(r, 200));
    await call(`/api/chats/${id}/send`, {text: '/goal'});
    expect((await evs).filter((e) => e.type === 'cmd' || e.type === 'log').map((e) => e.text)).toEqual(['/goal', expect.stringMatching(/^No goal set/)]);

    // /settings opens a window with every tab of the terminal's, and every config key.
    evs = events(id, (ev) => ev.type === 'window');
    await call(`/api/chats/${id}/send`, {text: '/settings safety'});
    const win = (await evs).find((e) => e.type === 'window').window;
    expect(win).toMatchObject({name: 'settings', tab: 'Safety', tabs: ['Status line', 'Sidebar', 'General', 'Agents', 'Accounts', 'Safety', 'Advanced']});
    expect(win.advanced.length).toBeGreaterThan(60);

    // Changing one goes through the same checks, and lands in config.json.
    expect((await ask('setting', {key: 'maxUsedPct', value: '85', typed: true})).value.advanced.find((k: any) => k.key === 'maxUsedPct').value).toBe('85');
    expect(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')).maxUsedPct).toBe(85);
    expect((await call(`/api/chats/${id}/request`, {op: 'setting', args: {key: 'maxUsedPct', value: 'lots', typed: true}})).json.error).toMatch(/is a number/);
    await ask('layout', {key: 'statusLine', ids: ['messages', 'context']});

    // The status line follows the layout.
    evs = events(id, (ev) => ev.type === 'chrome');
    await call(`/api/chats/${id}/send`, {text: '/cost'});
    const chrome = (await evs).find((e) => e.type === 'chrome');
    expect(chrome.status.map((s: any) => s.id)).toEqual(['messages', 'context']);
    expect(chrome.sidebar.map((s: any) => s.id)).toEqual(['agents', 'accounts', 'models', 'session']);

    // /model opens the model window; terminal-only commands say what to do instead.
    // (A page connecting gets the window that's open; /model replaces it.)
    evs = events(id, (ev) => ev.type === 'window' && ev.window?.name === 'model');
    await call(`/api/chats/${id}/send`, {text: '/model'});
    expect((await evs).find((e) => e.window?.name === 'model').window.sections.map((s: any) => s.id)).toEqual(['chat', 'subagent', 'priority', 'decision', 'compaction', 'advisor', 'web']);
    // (A page connecting also gets what earlier commands printed.)
    evs = events(id, (ev) => ev.type === 'log' && /terminal renderer/.test(ev.text));
    await call(`/api/chats/${id}/send`, {text: '/tui classic'});
    expect((await evs).at(-1).text).toBe('The web UI has one layout; /tui switches the terminal renderer.');
  }, 90_000);
});
