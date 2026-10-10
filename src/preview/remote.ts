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

/** Stream X display `:display` (Linux). Resolves once it's listening; rejects if it doesn't start. */
export function startRemote(bin: string, display: number, timeoutMs = 10_000): Promise<RemoteStream> {
  const token = randomBytes(24).toString('base64url');
  // The token goes in the environment, not the arguments (other users can read those).
  const p = spawn(bin, ['serve', '--display', `:${display}`, '--listen', '127.0.0.1:0'], {stdio: ['ignore', 'ignore', 'pipe'], env: {...process.env, REIN_REMOTE_TOKEN: token}});
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
