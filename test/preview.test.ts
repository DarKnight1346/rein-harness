import http from 'node:http';
import net from 'node:net';
import {inflateSync} from 'node:zlib';
import {afterEach, describe, expect, it} from 'vitest';
import {BrowserView, findBrowser, sandboxBlocked} from '../src/preview/cdp.js';
import {encodePng} from '../src/preview/png.js';
import {localUrls, Previews, vncTarget} from '../src/preview/registry.js';
import {previewTool} from '../src/preview/tool.js';
import {keysym, VncView} from '../src/preview/vnc.js';

describe('finding previews', () => {
  it('picks local URLs out of what dev servers print', () => {
    // Vite, with its colors; Next; python's http.server; and things that aren't local.
    expect(localUrls('  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m')).toEqual(['http://localhost:5173/']); // colors mid-URL
    expect(localUrls('  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.4:5173/')).toEqual(['http://localhost:5173/']);
    expect(localUrls('- ready started server on 0.0.0.0:3000, url: http://0.0.0.0:3000.')).toEqual(['http://localhost:3000/']);
    expect(localUrls('Serving HTTP on :: port 8000 (http://[::]:8000/) ...')).toEqual(['http://localhost:8000/']);
    expect(localUrls('see https://example.com and http://127.0.0.1:8080/app?x=1')).toEqual(['http://127.0.0.1:8080/app?x=1']);
  });

  it('reads VNC addresses', () => {
    expect(vncTarget(':1')).toBe('localhost:5901');
    expect(vncTarget('vnc://build-box:5905')).toBe('build-box:5905');
    expect(vncTarget('10.0.0.2:2')).toBe('10.0.0.2:5902');
    expect(vncTarget('nope')).toBeUndefined();
  });

  it("keeps one preview per target, and drops a detected one when its command ends", () => {
    const p = new Previews();
    const [a] = p.detect('Local: http://localhost:5173/', 7);
    expect(p.detect('again http://localhost:5173/', 7)).toEqual([]);
    p.add({kind: 'vnc', target: 'localhost:5901', title: 'VM', source: 'agent'});
    p.shellEnded(7);
    expect(p.list().map((x) => x.target)).toEqual(['localhost:5901']);
    expect(p.get(a!.id)).toBeUndefined();
  });

  it('gives the agent a preview tool for URLs and displays, never file:// or the like', async () => {
    const p = new Previews();
    const shown: number[] = [];
    const tool = previewTool(p, (id) => shown.push(id));
    const run = (args: object) => tool.run({root: '/'} as never, args);
    expect((await run({url: 'http://0.0.0.0:3000/dash', title: 'Dashboard'})).ok).toBe(true);
    expect((await run({vnc: ':1'})).text).toMatch(/localhost:5901/);
    expect((await run({url: 'file:///etc/passwd'})).ok).toBe(false);
    expect((await run({})).ok).toBe(false);
    expect(p.list().map((x) => [x.kind, x.target, x.title])).toEqual([['url', 'http://localhost:3000/dash', 'Dashboard'], ['vnc', 'localhost:5901', 'localhost:5901']]);
    expect(shown).toEqual([1, 2]);
  });
});

describe('the VNC preview', () => {
  it('writes a valid PNG of a region', () => {
    const fb = new Uint8Array(4 * 4 * 4).fill(200);
    const png = encodePng(fb, 4, 1, 1, 2, 2);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
    expect(inflateSync(idat)).toEqual(Buffer.from([0, 200, 200, 200, 200, 200, 200, 0, 200, 200, 200, 200, 200, 200]));
  });

  it('maps keys to X keysyms', () => {
    expect([keysym('a'), keysym('Enter'), keysym('ArrowUp'), keysym('F5'), keysym('é'), keysym('€')]).toEqual([0x61, 0xff0d, 0xff52, 0xffc2, 0xe9, 0x01000000 + 0x20ac]);
  });

  let server: net.Server | undefined;
  afterEach(() => server?.close());

  it('connects to a VNC server, draws what it sends, and sends clicks and keys back', async () => {
    // A tiny RFB 3.8 server: no auth, a 4×2 screen, one raw red rectangle, then records input.
    const got: number[][] = [];
    server = net.createServer((s) => {
      let stage = 0;
      s.write('RFB 003.008\n');
      s.on('data', (d: Buffer) => {
        if (stage === 0) ((stage = 1), s.write(Buffer.from([1, 1]))); // one security type: None
        else if (stage === 1) ((stage = 2), s.write(Buffer.from([0, 0, 0, 0]))); // SecurityResult OK
        else if (stage === 2) {
          stage = 3;
          const init = Buffer.alloc(24 + 4);
          init.writeUInt16BE(4, 0);
          init.writeUInt16BE(2, 2);
          init.writeUInt32BE(4, 20);
          init.write('test', 24);
          s.write(init);
        } else if (stage === 3 && d.includes(Buffer.from([3, 0]))) {
          stage = 4;
          const head = Buffer.from([0, 0, 0, 1, 0, 1, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0]); // 1 rect at 1,0 2×1 raw
          s.write(Buffer.concat([head, Buffer.from([0, 0, 255, 0, 0, 0, 255, 0])])); // B,G,R,0 ×2 = red
        } else if (stage === 4) for (let i = 0; i < d.length; ) {
          const len = d[i] === 5 ? 6 : d[i] === 4 ? 8 : d[i] === 3 ? 10 : d.length - i;
          if (d[i] === 5 || d[i] === 4) got.push([...d.subarray(i, i + len)]);
          i += len;
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const v = new VncView();
    const patch = new Promise<any>((r) => v.once('patch', r));
    await v.start(`127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    expect([v.name, v.width, v.height]).toEqual(['test', 4, 2]);
    const p = await patch;
    expect([p.x, p.y, p.w, p.h]).toEqual([1, 0, 2, 1]);
    const raw = inflateSync(Buffer.from(p.png, 'base64').subarray(Buffer.from(p.png, 'base64').indexOf('IDAT') + 4));
    expect([...raw.subarray(0, 7)]).toEqual([0, 255, 0, 0, 255, 0, 0]);
    v.input({type: 'mouse', action: 'down', x: 3, y: 1});
    v.input({type: 'key', action: 'down', key: 'q', code: 'KeyQ'});
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([[5, 1, 0, 3, 0, 1], [4, 1, 0, 0, 0, 0, 0, 0x71]]);
    v.close();
  });
});

describe('the web preview', async () => {
  const browser = await findBrowser();
  it.skipIf(!browser)('streams a page from a browser on this machine, follows clicks, and never opens file://', async () => {
    const page = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url === '/two' ? '<h1>Two</h1>' : '<a href="/two" style="display:block;font-size:60px">next</a>');
    });
    await new Promise<void>((r) => page.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(page.address() as net.AddressInfo).port}/`;
    const v = new BrowserView();
    // Each step with its own limit, and the browser's own words if one fails (CI can't be watched).
    let step = 'start';
    const within = <T,>(p: Promise<T>, what: string, ms = 15_000) =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s (sandbox blocked: ${blocked}; browser: ${v.diag() || 'said nothing'})`)), ms))]);
    const blocked = await sandboxBlocked();
    try {
      const frame = new Promise<any>((r) => v.once('frame', r));
      // The page itself (the stream starts on about:blank, before the navigation).
      const loaded = new Promise<void>((r) => v.on('loaded', (u) => u === url && r()));
      await within(v.start(url, {width: 640, height: 480}), (step = 'starting the browser'), 35_000);
      await within(loaded, (step = 'loading the page'));
      const f = await within(frame, (step = 'the first frame'));
      expect([f.width, f.height]).toEqual([640, 480]);
      const went = new Promise<string>((r) => v.on('navigated', (u) => u.endsWith('/two') && r(u)));
      await v.input({type: 'mouse', action: 'down', x: 30, y: 30});
      await v.input({type: 'mouse', action: 'up', x: 30, y: 30});
      expect(await within(went, (step = 'following a click'))).toBe(`${url}two`);
      await expect(v.navigate('file:///etc/hosts')).rejects.toThrow(/http\(s\) pages only/);
      void step;
    } finally {
      v.close();
      page.close();
    }
  }, 60_000);
});
