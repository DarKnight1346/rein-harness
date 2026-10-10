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
export function startRemote(bin: string, what: number | {window: string}, timeoutMs = 10_000): Promise<RemoteStream> {
  const token = randomBytes(24).toString('base64url');
  const source = typeof what === 'number' ? ['--display', `:${what}`] : ['--window', what.window];
  // The token goes in the environment, not the arguments (other users can read those).
  const p = spawn(bin, ['serve', ...source, '--listen', '127.0.0.1:0'], {stdio: ['ignore', 'ignore', 'pipe'], env: {...process.env, REIN_REMOTE_TOKEN: token}});
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
