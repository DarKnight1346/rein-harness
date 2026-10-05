import http from 'node:http';
import net from 'node:net';
import {mkdirSync, mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {Agent, setGlobalDispatcher} from 'undici';
import {layoutFor} from '../src/store/paths.js';
import {installProxy} from '../src/util/proxy.js';
import {Attachments} from '../src/ui/attachments.js';

describe('XDG base directories', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rein-xdg-'));
  it('split config, data and state on Linux when there is no ~/.rein', () => {
    expect(layoutFor({}, home, 'linux')).toEqual({config: path.join(home, '.config', 'rein'), data: path.join(home, '.local', 'share', 'rein'), state: path.join(home, '.local', 'state', 'rein')});
    expect(layoutFor({XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data', XDG_STATE_HOME: '/x/state'}, home, 'linux')).toEqual({config: '/x/cfg/rein', data: '/x/data/rein', state: '/x/state/rein'});
  });
  it('keep one folder for existing installs, macOS defaults and REIN_HOME', () => {
    const one = (dir: string) => ({config: dir, data: dir, state: path.join(dir, 'state')});
    expect(layoutFor({}, home, 'darwin')).toEqual(one(path.join(home, '.rein')));
    expect(layoutFor({REIN_HOME: '/r'}, home, 'linux')).toEqual(one('/r'));
    mkdirSync(path.join(home, '.rein'));
    expect(layoutFor({XDG_CONFIG_HOME: '/x/cfg'}, home, 'linux')).toEqual(one(path.join(home, '.rein')));
  });
});

describe('proxy', () => {
  afterAll(() => setGlobalDispatcher(new Agent()));
  it("routes Rein's requests through HTTPS_PROXY, never local ones or NO_PROXY hosts", async () => {
    const seen: string[] = [];
    const proxy = http.createServer((_q, s) => s.end());
    proxy.on('connect', (req, client) => {
      seen.push(req.url!);
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); // no need to really tunnel
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const local = http.createServer((_q, s) => s.end('local ok'));
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r));
    const shown = installProxy({HTTPS_PROXY: `http://me:secret@127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, NO_PROXY: 'internal.example'});
    expect(shown).not.toContain('secret');
    await fetch('https://example.com/').catch(() => undefined);
    expect(seen).toEqual(['example.com:443']);
    expect(await (await fetch(`http://127.0.0.1:${(local.address() as net.AddressInfo).port}/`)).text()).toBe('local ok');
    expect(seen).toHaveLength(1);
    proxy.close();
    local.close();
    expect(installProxy({})).toBeUndefined();
  });
});

describe('paste collapsing', () => {
  const big = Array.from({length: 10}, (_, i) => `line ${i}`).join('\n');
  it('is on by default, and can be turned off', async () => {
    expect(await new Attachments(() => os.tmpdir()).paste(big)).toBe('[Pasted text #1 +10 lines]');
    expect(await new Attachments(() => os.tmpdir(), () => false).paste(big)).toBe(big);
  });
});
