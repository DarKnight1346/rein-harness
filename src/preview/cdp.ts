import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {onPath} from '../lsp/servers.js';

/**
 * A web preview: headless Chrome (or Chromium, Edge) on this machine, driven over the DevTools
 * protocol, its screen streamed as JPEG frames (Page.startScreencast) and your clicks, scrolls and
 * keys sent back (Input.*). The browser runs where the servers run, so `localhost`, the app's calls
 * to its own API and hot reload all work, wherever you're looking from. Each view gets a fresh
 * profile in a temp folder (never yours) and only goes to http(s) pages.
 */
export type Frame = {data: string; width: number; height: number};
export type InputEvent =
  | {type: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clicks?: number}
  | {type: 'wheel'; x: number; y: number; dx: number; dy: number}
  | {type: 'key'; action: 'down' | 'up'; key: string; code: string; text?: string; modifiers?: number}
  | {type: 'text'; text: string};

/** The browser to use: $REIN_BROWSER, then the usual places for Chrome, Chromium and Edge. */
export async function findBrowser(): Promise<string | undefined> {
  const env = process.env.REIN_BROWSER;
  if (env && existsSync(env)) return env;
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
      : process.platform === 'win32'
        ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((d) => [path.join(d!, 'Google/Chrome/Application/chrome.exe'), path.join(d!, 'Microsoft/Edge/Application/msedge.exe'), path.join(d!, 'Chromium/Application/chrome.exe')])
        : [];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome']) {
    const p = onPath(name);
    if (p) return p;
  }
  return undefined;
}

const allowed = (url: string) => /^(https?:|about:blank)/i.test(url);

export class BrowserView extends EventEmitter {
  private proc: ChildProcess | undefined;
  private ws: WebSocket | undefined;
  private profile: string | undefined;
  private seq = 0;
  private pending = new Map<number, {resolve(v: any): void; reject(e: Error): void}>();
  private size = {width: 1280, height: 800};
  private streaming = false;
  closed = false;
  url = '';

  /** Start the browser and open `url` at the viewer's size (30 s at most, with the browser's own words if it fails). */
  async start(url: string, size: {width: number; height: number}): Promise<void> {
    if (!allowed(url)) throw new Error('a preview shows http(s) pages only');
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`the browser didn't come up in 30 s${this.stderr ? `: ${tail(this.stderr)}` : ''}`)), 30_000)));
    try {
      this.startUrl = url;
      await Promise.race([this.launch(url, size), limit]);
    } catch (err) {
      this.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private stderr = '';

  private startUrl = '';
  private recovered = false;

  private async launch(url: string, size: {width: number; height: number}, forceNoSandbox = false): Promise<void> {
    const bin = await findBrowser();
    if (!bin) throw new Error('no Chrome, Chromium or Edge found on this machine (set REIN_BROWSER to one)');
    this.size = clampSize(size);
    this.profile ??= await mkdtemp(path.join(os.tmpdir(), 'rein-preview-'));
    // Chrome's sandbox can't run as root, and newer Linux kernels (Ubuntu 23.10+) may refuse the user
    // namespaces it needs: then it's started again without it (the page is still a separate process).
    const asRoot = process.platform === 'linux' && process.getuid?.() === 0;
    let wsBase: string;
    try {
      wsBase = await this.spawnBrowser(bin, forceNoSandbox || asRoot || (await sandboxBlocked()));
    } catch (err) {
      if (process.platform !== 'linux' || asRoot || !/sandbox|namespace|zygote/i.test(String((err as Error).message) + this.stderr)) throw err;
      wsBase = await this.spawnBrowser(bin, true);
    }
    // The tab Chrome opened (the active one: a background tab gets no screencast), over the tab's own
    // connection, which outlives navigations and process swaps.
    const base = wsBase.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1');
    let tab: {webSocketDebuggerUrl?: string} | undefined;
    for (let i = 0; i < 50 && !tab; i++) {
      tab = ((await (await fetch(`${base}/json/list`)).json()) as {type: string; webSocketDebuggerUrl?: string}[]).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!tab) await new Promise((r) => setTimeout(r, 100));
    }
    if (!tab) throw new Error('the browser opened no page');
    this.ws = new WebSocket(tab.webSocketDebuggerUrl!);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error('could not connect to the browser'));
    });
    this.ws.onmessage = (m) => this.onMessage(JSON.parse(String(m.data)));
    this.ws.onclose = () => this.close();
    await this.call('Page.enable');
    await this.call('Inspector.enable').catch(() => {});
    await this.call('Runtime.enable').catch(() => {});
    // file:// and the like never load: the page asked for them, not you.
    await this.call('Fetch.enable', {patterns: [{urlPattern: 'file://*'}, {urlPattern: 'chrome://*'}, {urlPattern: 'devtools://*'}, {urlPattern: 'chrome-extension://*'}]});
    await this.resize(this.size);
    // The screencast starts before the navigation: started while one is in flight, it's refused.
    await this.stream(true);
    await this.navigate(url);
  }

  private async spawnBrowser(bin: string, noSandbox: boolean): Promise<string> {
    this.proc?.kill();
    this.stderr = '';
    const linux = process.platform === 'linux';
    this.proc = spawn(bin, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-features=Translate,MediaRouter',
      '--hide-scrollbars', '--mute-audio', `--window-size=${this.size.width},${this.size.height}`,
      // Containers often have a tiny /dev/shm, and servers no GPU.
      ...(linux ? ['--disable-dev-shm-usage', '--disable-gpu'] : []),
      ...(noSandbox ? ['--no-sandbox'] : []),
      'about:blank',
    ], {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
    // Only this browser's exit closes the view (a first try, without the sandbox fallback, may exit later).
    const proc = this.proc;
    proc.on('exit', () => this.proc === proc && this.close());
    return this.devtoolsUrl();
  }

  /** Chrome prints its DevTools address on stderr when it's ready. */
  private devtoolsUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`the browser did not start${buf ? `: ${tail(buf)}` : ''}`)), 12_000);
      this.proc!.stderr!.on('data', (d) => {
        buf += d;
        this.stderr = (this.stderr + d).slice(-4000);
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      this.proc!.on('exit', () => (clearTimeout(timer), reject(new Error(`the browser exited${buf ? `: ${tail(buf)}` : ''}`))));
      // The port file is the other way to learn it (some builds print nothing).
      void (async () => {
        for (let i = 0; i < 100 && !this.closed; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const port = await readFile(path.join(this.profile!, 'DevToolsActivePort'), 'utf8').catch(() => '');
          const [p, rest] = port.split('\n');
          if (p && rest) {
            clearTimeout(timer);
            return resolve(`ws://127.0.0.1:${p.trim()}${rest.trim()}`);
          }
        }
      })();
    });
  }

  private call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('the browser is closed'));
      this.pending.set(id, {resolve, reject: (e: Error) => reject(new Error(`${method}: ${e.message}`))});
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }

  private onMessage(m: any): void {
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    switch (m.method) {
      case 'Page.screencastFrame':
        void this.call('Page.screencastFrameAck', {sessionId: m.params.sessionId}).catch(() => {});
        this.emit('frame', {data: m.params.data, width: m.params.metadata.deviceWidth, height: m.params.metadata.deviceHeight} satisfies Frame);
        break;
      case 'Fetch.requestPaused':
        void this.call('Fetch.failRequest', {requestId: m.params.requestId, errorReason: 'BlockedByClient'}).catch(() => {});
        break;
      case 'Page.frameNavigated':
        if (!m.params.frame.parentId) {
          this.url = m.params.frame.url;
          // Chrome's own error page ("can't be reached": the server isn't up yet) stays; anything else not http(s) goes.
          if (!allowed(this.url) && !this.url.startsWith('chrome-error://')) void this.navigate('about:blank');
          this.emit('navigated', this.url);
        }
        break;
      case 'Inspector.targetCrashed':
        void this.recover();
        break;
      case 'Page.loadEventFired':
        // A screencast sends frames on paints; a page that's done painting gets one frame now.
        void this.call('Page.captureScreenshot', {format: 'jpeg', quality: 70}).then((r) => this.emit('frame', {data: r.data, width: this.size.width, height: this.size.height} satisfies Frame), () => {});
        break;
      case 'Page.javascriptDialogOpening':
        // An alert would freeze the stream: dismiss it, and say what it said.
        this.emit('notice', `The page showed a dialog: ${m.params.message}`);
        void this.call('Page.handleJavaScriptDialog', {accept: m.params.type !== 'beforeunload'}).catch(() => {});
        break;
    }
  }

  async navigate(url: string): Promise<void> {
    if (!allowed(url)) throw new Error('a preview shows http(s) pages only');
    await this.call('Page.navigate', {url});
  }

  async history(dir: 'back' | 'forward' | 'reload'): Promise<void> {
    if (dir === 'reload') return void (await this.call('Page.reload'));
    const h = await this.call('Page.getNavigationHistory');
    const entry = h.entries[h.currentIndex + (dir === 'back' ? -1 : 1)];
    if (entry && allowed(entry.url)) await this.call('Page.navigateToHistoryEntry', {entryId: entry.id});
  }

  /** Frames only while someone is looking (a watcher came or went). */
  async stream(on: boolean): Promise<void> {
    if (on === this.streaming || this.closed) return;
    this.streaming = on;
    if (on) await this.call('Page.startScreencast', {format: 'jpeg', quality: 70, maxWidth: this.size.width, maxHeight: this.size.height, everyNthFrame: 1});
    else await this.call('Page.stopScreencast').catch(() => {});
  }

  async resize(size: {width: number; height: number}): Promise<void> {
    this.size = clampSize(size);
    await this.call('Emulation.setDeviceMetricsOverride', {...this.size, deviceScaleFactor: 1, mobile: this.size.width < 600});
    if (this.streaming) {
      this.streaming = false;
      await this.call('Page.stopScreencast').catch(() => {});
      await this.stream(true);
    }
  }

  async input(ev: InputEvent): Promise<void> {
    if (ev.type === 'mouse') {
      const type = ev.action === 'move' ? 'mouseMoved' : ev.action === 'down' ? 'mousePressed' : 'mouseReleased';
      await this.call('Input.dispatchMouseEvent', {type, x: ev.x, y: ev.y, button: ev.action === 'move' ? 'none' : (ev.button ?? 'left'), clickCount: ev.clicks ?? (ev.action === 'move' ? 0 : 1)});
    } else if (ev.type === 'wheel') {
      await this.call('Input.dispatchMouseEvent', {type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy});
    } else if (ev.type === 'key') {
      const printable = ev.action === 'down' && ev.text && ev.text.length === 1 && !(ev.modifiers ?? 0 & 6);
      await this.call('Input.dispatchKeyEvent', {type: ev.action === 'down' ? (printable ? 'keyDown' : 'rawKeyDown') : 'keyUp', key: ev.key, code: ev.code, modifiers: ev.modifiers ?? 0, windowsVirtualKeyCode: vk(ev.key), ...(printable ? {text: ev.text} : {})});
    } else if (ev.type === 'text') {
      await this.call('Input.insertText', {text: ev.text});
    }
  }

  /**
   * The page's process died. On Linux that's usually the sandbox (a kernel that won't give it the
   * namespaces it needs, in a way Rein couldn't see beforehand): start again without it, once.
   */
  private async recover(): Promise<void> {
    if (this.recovered || process.platform !== 'linux' || this.closed) return void this.emit('notice', 'The preview’s page crashed.');
    this.recovered = true;
    const url = /^https?:/i.test(this.url) ? this.url : this.startUrl;
    const old = this.ws;
    this.ws = undefined;
    old && (old.onclose = null);
    old?.close();
    this.proc?.kill();
    this.streaming = false;
    try {
      await this.launch(url, this.size, true);
    } catch (err) {
      this.emit('notice', `The preview’s page crashed and couldn’t restart: ${(err as Error).message}`);
      this.close();
    }
  }

  /** The browser's last words, for an error message. */
  diag(): string {
    return tail(this.stderr);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {}
    this.proc?.kill();
    for (const p of this.pending.values()) p.reject(new Error('the preview closed'));
    this.pending.clear();
    const dir = this.profile;
    if (dir) setTimeout(() => void rm(dir, {recursive: true, force: true}).catch(() => {}), 1500).unref();
    this.emit('closed');
  }
}

/**
 * Linux kernels that won't give Chrome's sandbox the user namespaces it needs: Ubuntu 23.10+ (AppArmor's
 * apparmor_restrict_unprivileged_userns, also on GitHub's runners) or unprivileged_userns_clone off.
 * The browser itself starts, but every page process dies, so Rein starts it without the sandbox there.
 */
export async function sandboxBlocked(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const read = (f: string) => readFile(f, 'utf8').then((x) => x.trim(), () => '');
  return (await read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')) === '1' || (await read('/proc/sys/kernel/unprivileged_userns_clone')) === '0';
}

const tail = (s: string) => s.trim().split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(0, 300);
const clampSize = (s: {width: number; height: number}) => ({width: Math.max(320, Math.min(2560, Math.round(s.width) || 1280)), height: Math.max(240, Math.min(1600, Math.round(s.height) || 800))});

/** Windows virtual-key codes for the keys a page usually listens to (Enter, arrows, Backspace…). */
function vk(key: string): number {
  const named: Record<string, number> = {Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Meta: 91};
  if (named[key] !== undefined) return named[key]!;
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  const f = key.match(/^F(\d{1,2})$/);
  return f ? 111 + Number(f[1]) : 0;
}
