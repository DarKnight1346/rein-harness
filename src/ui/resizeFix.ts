import {createRequire} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import stringWidth from 'string-width';

type InkInternals = {
  lastTerminalWidth: number;
  lastOutput: string;
  lastOutputToRender: string;
  log: {reset(): void};
};

/**
 * Resize without wiping history.
 *
 * When the window narrows, the terminal reflows Ink's last frame (each full-width line becomes
 * several rows), but Ink erases only the frame's original line count, leaving stale copies of the
 * input box / status bar behind. This listener runs *before* Ink's: it erases exactly the rows the
 * reflowed frame now occupies and resets Ink's line bookkeeping, so Ink's own erase is a no-op and
 * it simply draws the new frame. Static transcript lines above are never touched, so scrollback
 * survives. No-op if Ink's internals change shape.
 */
let mode: 'classic' | 'fullscreen' = 'classic';
/** Fullscreen (alt screen) has no scrollback to protect: wipe it and let Ink redraw everything. */
export const setResizeMode = (m: 'classic' | 'fullscreen') => void (mode = m);

let instances: WeakMap<object, InkInternals> | undefined;

/** The frame Ink last drew (classic): what's on screen below the transcript. */
export const inkFrame = (stdout: NodeJS.WriteStream): string => {
  const ink = instances?.get(stdout);
  return ink ? ink.lastOutputToRender || (ink.lastOutput ? ink.lastOutput + '\n' : '') : '';
};

/**
 * After something else had the terminal (a command the user typed into): erase the frame that was
 * on screen when it took over, and make Ink draw the whole current frame afresh.
 */
export function redrawAfterTakeover(stdout: NodeJS.WriteStream, frame: string): void {
  const ink = instances?.get(stdout);
  if (mode === 'fullscreen') {
    stdout.write('\x1b[2J\x1b[H');
  } else if (frame) {
    stdout.write('\r' + '\x1b[2K' + '\x1b[1A\x1b[2K'.repeat(reflowedRows(frame, stdout.columns ?? 80)) + '\r');
  }
  if (ink && typeof ink.log?.reset === 'function') {
    ink.log.reset();
    ink.lastOutput = '';
    ink.lastOutputToRender = '';
  }
  stdout.emit('resize');
}

export async function installResizeFix(stdout: NodeJS.WriteStream): Promise<void> {
  try {
    // The dist/cli.js bundle inlines Ink and hands its map over (scripts/bundle.mjs): Ink's file on
    // disk would be a second, empty copy.
    instances = (globalThis as {__reinInkInstances?: typeof instances}).__reinInkInstances;
    if (!instances) {
      const require = createRequire(import.meta.url);
      const inkDir = path.dirname(require.resolve('ink'));
      instances = (await import(pathToFileURL(path.join(inkDir, 'instances.js')).href)).default;
    }
  } catch {
    return;
  }
  stdout.prependListener('resize', () => {
    const ink = instances?.get(stdout);
    if (!ink || typeof ink.log?.reset !== 'function') return;
    if (mode === 'fullscreen') {
      // The terminal reflows the alt screen too; diffing against it leaves fragments.
      stdout.write('\x1b[2J\x1b[H');
      ink.log.reset();
      ink.lastOutput = '';
      ink.lastOutputToRender = '';
      return;
    }
    const cols = stdout.columns ?? 80;
    if (cols >= ink.lastTerminalWidth) return; // widening doesn't change the frame's row count
    const frame = ink.lastOutputToRender || (ink.lastOutput ? ink.lastOutput + '\n' : '');
    if (!frame) return;
    const rows = reflowedRows(frame, cols);
    // Cursor sits on the line after the frame: erase it plus every reflowed frame row above it.
    stdout.write('\r' + '\x1b[2K' + '\x1b[1A\x1b[2K'.repeat(rows) + '\r');
    ink.log.reset();
  });
}

/** Rows a previously drawn frame occupies after the terminal rewraps it at `cols`. */
export function reflowedRows(frame: string, cols: number): number {
  const lines = frame.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.reduce((n, line) => n + Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, cols))), 0);
}

/**
 * A terminal that reports no size (0×0: an unsized pty, some embedded terminals) sends Ink to the
 * `terminal-size` fallback on every frame, and that opens /dev/tty without ever closing it: dozens
 * of leaked descriptors a second, until spawning processes fails. Give stdout a size instead
 * ($COLUMNS/$LINES, else 100×30), and again after any resize that reports zero.
 */
export function ensureTerminalSize(stdout: NodeJS.WriteStream, env: NodeJS.ProcessEnv = process.env): void {
  if (!stdout.isTTY) return;
  const fill = () => {
    if (!stdout.columns) stdout.columns = Number(env.COLUMNS) || 100;
    if (!stdout.rows) stdout.rows = Number(env.LINES) || 30;
  };
  fill();
  stdout.prependListener('resize', fill);
}
