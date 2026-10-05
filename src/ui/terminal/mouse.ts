import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {splitVoiceKeys, voiceKeys} from './voiceKey.js';

/**
 * SGR mouse (1006) with press/release + wheel (1000) and motion only while a button is held
 * (1002, for drag-to-select). No any-motion tracking (1003).
 */
export const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l\x1b[?1000l';

export type MouseEvent = {
  kind: 'down' | 'up' | 'drag' | 'wheelUp' | 'wheelDown';
  button: 'left' | 'middle' | 'right' | 'none';
  /** 0-based cell coordinates. */
  x: number;
  y: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
};

const SEQ = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** A mouse sequence cut off at the end of a chunk. */
const PARTIAL = /\x1b\[<[\d;]*$/;

export function decode(b: number, x: number, y: number, final: 'M' | 'm'): MouseEvent {
  const mods = {shift: !!(b & 4), meta: !!(b & 8), ctrl: !!(b & 16)};
  if (b & 64) return {kind: b & 1 ? 'wheelDown' : 'wheelUp', button: 'none', x: x - 1, y: y - 1, ...mods};
  const button = (['left', 'middle', 'right', 'none'] as const)[b & 3]!;
  if (b & 32) return {kind: 'drag', button, x: x - 1, y: y - 1, ...mods};
  return {kind: final === 'm' ? 'up' : 'down', button, x: x - 1, y: y - 1, ...mods};
}

/** Split terminal input into mouse events and everything else (passed on to Ink). */
export function splitMouse(data: string): {text: string; events: MouseEvent[]; pending: string} {
  const events: MouseEvent[] = [];
  let text = data.replace(SEQ, (_m, b, x, y, f) => {
    events.push(decode(Number(b), Number(x), Number(y), f));
    return '';
  });
  const partial = PARTIAL.exec(text);
  const pending = partial ? partial[0] : '';
  if (pending) text = text.slice(0, -pending.length);
  return {text, events, pending};
}

/**
 * stdin stand-in handed to Ink: strips mouse sequences before Ink's key parser sees them (they'd
 * otherwise arrive as typed text) and emits them on `mouse`; Ctrl+Space goes to `voiceKeys`
 * (push-to-talk) and kitty key-release events are dropped. Everything else — keys, pastes, the
 * kitty-protocol query reply — passes through unchanged. Both renderers use it (classic without
 * turning mouse reporting on).
 */
export class MouseStdin extends Readable {
  readonly isTTY = true;
  readonly mouse = new EventEmitter();
  private pending = '';
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly src: NodeJS.ReadStream = process.stdin) {
    super({read() {}});
    src.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()));
  }

  get isRaw() {
    return this.src.isRaw;
  }

  setRawMode(mode: boolean): this {
    this.src.setRawMode?.(mode);
    return this;
  }

  override pause(): this {
    super.pause();
    return this;
  }

  ref(): this {
    this.src.ref();
    return this;
  }

  unref(): this {
    this.src.unref();
    return this;
  }

  private onData(data: string): void {
    clearTimeout(this.flushTimer);
    const {text: rest, events, pending} = splitMouse(this.pending + data);
    this.pending = pending;
    // Ctrl+Space (push-to-talk) and key releases never reach Ink's key handlers.
    const {text, events: keys} = splitVoiceKeys(rest);
    if (text) this.push(text);
    for (const k of keys) voiceKeys.emit('key', k);
    for (const ev of events) this.mouse.emit('mouse', ev);
    // A sequence split across reads normally completes within a millisecond; don't hold input forever.
    if (pending) this.flushTimer = setTimeout(() => this.flushPending(), 50);
  }

  private flushPending(): void {
    if (this.pending) this.push(this.pending);
    this.pending = '';
  }
}

let restoreInstalled = false;

/**
 * Make sure the terminal never stays in mouse-reporting / alt-screen mode, even on crashes or
 * signals: otherwise every click in the user's shell prints escape garbage.
 */
export function installTerminalRestore(): void {
  if (restoreInstalled) return;
  restoreInstalled = true;
  const off = () => {
    try {
      process.stdout.write(MOUSE_OFF);
    } catch {}
  };
  const hard = () => {
    try {
      process.stdout.write(MOUSE_OFF + '\x1b[?1049l\x1b[?25h');
    } catch {}
  };
  process.on('exit', off);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      hard();
      process.exit(130);
    });
  }
  process.on('uncaughtException', (err) => {
    hard();
    console.error(err);
    process.exit(1);
  });
}
