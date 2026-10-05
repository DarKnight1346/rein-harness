import {EventEmitter} from 'node:events';

/**
 * Push-to-talk on Ctrl+Space: hold to record, let go to stop.
 *
 * Terminals with the kitty keyboard protocol (kitty, WezTerm, Ghostty, foot, recent iTerm2)
 * report the release itself (`CSI 32;5:3u`). Others (Terminal.app, most xterms) only send NUL
 * for Ctrl+Space, again and again while it's held (key repeat): there, the recording stops once
 * the repeats stop. A short tap (no repeats) leaves it recording until the next press, so it
 * also works with key repeat turned off.
 */
export type VoiceKeyEvent = {kind: 'press' | 'repeat' | 'release'; protocol: 'kitty' | 'legacy'};

/** Kitty: Ctrl+Space (codepoint 32, modifiers with ctrl and nothing but lock keys), any event type. */
const KITTY_CTRL_SPACE = /\x1b\[32;(\d+)(?::([123]))?u/g;
/** Every other kitty release event: Rein's key handlers act on presses only. */
const KITTY_RELEASE = /\x1b\[[\d:]*;[\d:]*?\d+:3(?:;[\d:]*)?[u~A-Z]/g;

const isCtrlOnly = (mods: number) => ((mods - 1) & ~(64 | 128)) === 4; // ctrl, ignoring caps/num lock

/** Take Ctrl+Space (both encodings) and kitty release events out of terminal input. */
export function splitVoiceKeys(data: string): {text: string; events: VoiceKeyEvent[]} {
  const events: VoiceKeyEvent[] = [];
  let text = data.replace(KITTY_CTRL_SPACE, (m, mods, type) => {
    if (!isCtrlOnly(Number(mods))) return m;
    events.push({kind: type === '3' ? 'release' : type === '2' ? 'repeat' : 'press', protocol: 'kitty'});
    return '';
  });
  text = text.replace(KITTY_RELEASE, '');
  if (text.includes('\x00')) {
    for (const _ of text.matchAll(/\x00/g)) events.push({kind: 'press', protocol: 'legacy'});
    text = text.replace(/\x00/g, '');
  }
  return {text, events};
}

/** Ctrl+Space as typed: the stdin filter emits `key`, the UI listens for `start` / `stop`. */
export const voiceKeys = new EventEmitter();

/** No repeat this long after the press: it was a tap (toggle until the next press). */
export const TAP_MS = 700;
/** Held (legacy terminals): repeats stopping for this long means the key was let go. */
export const RELEASE_GAP_MS = 250;

/** Turns key events into start/stop. `now` and timers are injectable for tests. */
export class PushToTalk extends EventEmitter {
  private state: 'idle' | 'pending' | 'held' | 'toggled' = 'idle';
  private lastAt = 0;
  private interval = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly clock: () => number = Date.now) {
    super();
  }

  get recording(): boolean {
    return this.state !== 'idle';
  }

  /** The UI stopped or cancelled on its own (Ctrl+C, the 2-minute cap). */
  reset(): void {
    clearTimeout(this.timer);
    this.state = 'idle';
  }

  key(ev: VoiceKeyEvent): void {
    const now = this.clock();
    if (ev.protocol === 'kitty') {
      if (ev.kind === 'press' && this.state === 'idle') this.start('held');
      else if (ev.kind === 'press' && this.state === 'toggled') this.stop();
      else if (ev.kind === 'release' && this.state === 'held') {
        // A tap shorter than a key repeat's delay is a toggle (same as legacy terminals).
        if (now - this.lastAt < 300) this.toggled();
        else this.stop();
      }
      return;
    }
    // Legacy: every NUL looks the same; timing tells presses from repeats.
    if (this.state === 'idle') {
      this.lastAt = now;
      this.interval = 0;
      this.start('pending');
      this.arm(TAP_MS, () => this.toggled());
      return;
    }
    if (this.state === 'toggled') return this.stop();
    // pending → held on the first repeat; each repeat pushes the "let go" deadline out.
    this.interval = this.interval ? Math.min(this.interval, now - this.lastAt) : now - this.lastAt;
    this.lastAt = now;
    this.state = 'held';
    this.arm(Math.max(RELEASE_GAP_MS, this.interval * 2.5), () => this.stop());
  }

  private start(state: 'pending' | 'held'): void {
    this.state = state;
    this.lastAt = this.clock();
    this.emit('start');
  }

  private toggled(): void {
    this.state = 'toggled';
    this.emit('toggled');
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.state = 'idle';
    this.emit('stop');
  }

  private arm(ms: number, fn: () => void): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(fn, ms);
    this.timer.unref?.();
  }
}
