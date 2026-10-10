import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {onPath} from '../lsp/servers.js';
import {reinHome} from '../store/paths.js';

/**
 * Rein Remote (github.com/rein-harness/rein-remote): streams a display as video (H.264, decoded by the
 * browser with WebCodecs) instead of image patches, with the pointer apart and only what changed
 * encoded. Used for app previews when it's installed; the VNC path stays as the fallback. It
 * listens on this computer only, behind a token; the web UI proxies the page's WebSocket to it after
 * its own checks, so it works through Tailscale and a reverse proxy like the rest of the page.
 */
export type RemoteStream = {port: number; token: string; stop(): void};

/** The rein-remote binary: `setting` is the reinRemote config value (auto, off, or a path). */
export function remoteBinary(setting: string | undefined): string | undefined {
  const s = (setting ?? 'auto').trim();
  if (s === 'off') return undefined;
  if (s && s !== 'auto') return existsSync(s) ? s : undefined;
  const own = path.join(reinHome(), 'bin', process.platform === 'win32' ? 'rein-remote.exe' : 'rein-remote');
  return existsSync(own) ? own : onPath('rein-remote');
}

/** A window rein-remote can show (`rein-remote windows --json`). */
export type RemoteWindow = {id: number; app: string; title: string; width: number; height: number};

/** The windows on this computer's screen, front to back. */
export function remoteWindows(bin: string): Promise<RemoteWindow[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['windows', '--json'], {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    p.stdout!.on('data', (d) => (out += d));
    p.stderr!.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().replace(/^rein-remote: /, '') || `rein-remote windows failed (${code})`));
      try {
        resolve(JSON.parse(out) as RemoteWindow[]);
      } catch {
        reject(new Error("rein-remote's window list isn't JSON (an old version?)"));
      }
    });
  });
}

/**
 * Stream X display `:display` (Linux), or one window (any OS: an id from remoteWindows, or part of its
 * title or app's name). Resolves once it's listening; rejects if it doesn't start.
 */
export function startRemote(bin: string, what: number | {window: string} | {vnc: string; password?: string}, timeoutMs = 10_000): Promise<RemoteStream> {
  const token = randomBytes(24).toString('base64url');
  const source = typeof what === 'number' ? ['--display', `:${what}`] : 'window' in what ? ['--window', what.window] : ['--vnc', what.vnc];
  // The token and a VNC password go in the environment, not the arguments (other users can read
  // those). WebTransport off: the web UI's page reaches it through Rein's proxy, over the WebSocket.
  const env = {...process.env, REIN_REMOTE_TOKEN: token, ...(typeof what !== 'number' && 'vnc' in what && what.password ? {REIN_REMOTE_VNC_PASSWORD: what.password} : {})};
  const p = spawn(bin, ['serve', ...source, '--listen', '127.0.0.1:0', '--webtransport', 'off'], {stdio: ['ignore', 'ignore', 'pipe'], env});
  const stop = () => p.kill();
  return new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => (stop(), reject(new Error(`rein-remote didn't start${err ? `: ${err.trim().split('\n').pop()}` : ''}`))), timeoutMs);
    p.on('error', (e) => (clearTimeout(timer), reject(e)));
    p.on('exit', (code) => (clearTimeout(timer), reject(new Error(`rein-remote stopped (${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`))));
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (chunk: string) => {
      err = (err + chunk).slice(-4000);
      const m = err.match(/on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        p.removeAllListeners('exit');
        resolve({port: Number(m[1]), token, stop});
      }
    });
  });
}

export const REMOTE_REPO = 'rein-harness/rein-remote';

/** The release build for this machine (Rust's target names), or undefined where there's none. */
export function remoteTarget(platform = process.platform, arch = process.arch): string | undefined {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
  if (!cpu) return undefined;
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'linux') return `${cpu}-unknown-linux-gnu`;
  if (platform === 'win32' && cpu === 'x86_64') return 'x86_64-pc-windows-msvc';
  return undefined;
}

/** `sha256  name` lines (sha256sum's format) as name → hash. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) out.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return out;
}

/**
 * Install Rein Remote's latest release into ~/.rein/bin: this machine's build, checked against the
 * release's SHA256SUMS before anything is unpacked. Asked for by the user (/preview install) or the
 * agent's remote_install tool (which always asks first).
 */
export async function installRemote(fetchImpl: typeof fetch = fetch): Promise<{ok: boolean; text: string}> {
  const {createHash} = await import('node:crypto');
  const {copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} = await import('node:fs');
  const os = await import('node:os');
  const {latestRelease, unpack, findFile} = await import('../lsp/servers.js');
  const target = remoteTarget();
  if (!target) return {ok: false, text: `Rein Remote has no build for ${process.platform}/${process.arch} yet.`};
  try {
    const {tag, assets} = await latestRelease(REMOTE_REPO);
    const asset = `rein-remote-${tag}-${target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
    if (!assets.includes(asset)) return {ok: false, text: `Rein Remote ${tag} has no ${asset}.`};
    const get = async (name: string) => {
      const r = await fetchImpl(`https://github.com/${REMOTE_REPO}/releases/download/${tag}/${name}`);
      if (!r.ok) throw new Error(`download of ${name} failed (HTTP ${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    };
    const want = parseSums((await get('SHA256SUMS')).toString('utf8')).get(asset);
    if (!want) return {ok: false, text: `Rein Remote ${tag}'s SHA256SUMS doesn't list ${asset}: not installing it.`};
    const archive = await get(asset);
    const got = createHash('sha256').update(archive).digest('hex');
    if (got !== want) return {ok: false, text: `${asset} doesn't match its SHA256SUMS (expected ${want}, got ${got}): not installing it.`};
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'rein-remote-'));
    try {
      const file = path.join(tmp, asset);
      writeFileSync(file, archive);
      const exe = process.platform === 'win32' ? 'rein-remote.exe' : 'rein-remote';
      const out = path.join(tmp, 'out');
      mkdirSync(out);
      await unpack(file, asset, out, path.join(`rein-remote-${tag}-${target}`, exe)).catch(() => {});
      const found = findFile(out, exe);
      if (!found) return {ok: false, text: `${exe} wasn't in ${asset}.`};
      const dir = path.join(reinHome(), 'bin');
      mkdirSync(dir, {recursive: true});
      const dest = path.join(dir, exe);
      copyFileSync(found, dest);
      if (process.platform !== 'win32') chmodSync(dest, 0o755);
      return {ok: true, text: `Installed Rein Remote ${tag} (${target}) to ${dest}, checked against its SHA256SUMS.`};
    } finally {
      rmSync(tmp, {recursive: true, force: true});
    }
  } catch (err) {
    return {ok: false, text: `Couldn't install Rein Remote: ${(err as Error).message}`};
  }
}

/**
 * A VNC preview (a VM, an emulator) as video with Rein Remote when it's installed: started on the
 * display (with its password when there is one) and stopped with the preview. Without it, or if it
 * can't connect, the preview stays on the frames path, which asks for a password when one's needed.
 */
export async function remoteForVnc(p: {target: string; password?: string; remote?: {port: number; token: string}; stop?(): void}, setting: string | undefined): Promise<void> {
  const bin = remoteBinary(setting);
  if (!bin || p.remote) return;
  const r = await startRemote(bin, {vnc: p.target, ...(p.password ? {password: p.password} : {})}).catch(() => undefined);
  if (!r) return;
  const before = p.stop;
  p.remote = {port: r.port, token: r.token};
  p.stop = () => (r.stop(), before?.());
}

/**
 * A web preview as video: the headless browser's screencast frames (JPEG) piped into rein-remote
 * (`serve --pipe`), which encodes them as H.264; what the viewer does comes back as the browser
 * view's own input events. A frame that can't be written at once (rein-remote is behind) is dropped.
 */
export async function startPipe(bin: string, size: {width: number; height: number}, onInput: (ev: Record<string, unknown>) => void): Promise<RemoteStream & {frame(jpeg: Buffer): void}> {
  const token = randomBytes(24).toString('base64url');
  const w = Math.max(2, Math.round(size.width)) & ~1, h = Math.max(2, Math.round(size.height)) & ~1;
  const p = spawn(bin, ['serve', '--pipe', `${w}x${h}`, '--listen', '127.0.0.1:0', '--webtransport', 'off'], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, REIN_REMOTE_TOKEN: token}});
  p.stdin!.on('error', () => {});
  let busy = false;
  p.stdin!.on('drain', () => (busy = false));
  let line = '';
  p.stdout!.setEncoding('utf8');
  p.stdout!.on('data', (chunk: string) => {
    line += chunk;
    for (let i; (i = line.indexOf('\n')) >= 0; line = line.slice(i + 1)) {
      try {
        onInput(JSON.parse(line.slice(0, i)));
      } catch {}
    }
  });
  const stop = () => p.kill();
  const port = await new Promise<number>((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => (stop(), reject(new Error('rein-remote didn\'t start'))), 10_000);
    p.on('error', (e) => (clearTimeout(timer), reject(e)));
    p.stderr!.setEncoding('utf8');
    p.stderr!.on('data', (c: string) => {
      err = (err + c).slice(-4000);
      const m = err.match(/on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) (clearTimeout(timer), resolve(Number(m[1])));
    });
  });
  return {
    port,
    token,
    stop,
    frame(jpeg) {
      if (busy || !p.stdin!.writable) return;
      const len = Buffer.alloc(4);
      len.writeUInt32LE(jpeg.length);
      busy = !p.stdin!.write(Buffer.concat([len, jpeg]));
    },
  };
}
