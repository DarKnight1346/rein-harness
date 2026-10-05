import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {PushToTalk, splitVoiceKeys, type VoiceKeyEvent} from '../src/ui/terminal/voiceKey.js';

describe('Ctrl+Space in terminal input', () => {
  it('takes Ctrl+Space out (kitty and legacy) and drops other key releases', () => {
    expect(splitVoiceKeys('a\x1b[32;5u b')).toEqual({text: 'a b', events: [{kind: 'press', protocol: 'kitty'}]});
    expect(splitVoiceKeys('\x1b[32;5:2u\x1b[32;5:3u').events.map((e) => e.kind)).toEqual(['repeat', 'release']);
    expect(splitVoiceKeys('\x1b[32;69:3u').events).toEqual([{kind: 'release', protocol: 'kitty'}]); // with caps lock
    expect(splitVoiceKeys('\x1b[32;6u').text).toBe('\x1b[32;6u'); // Ctrl+Shift+Space isn't ours
    expect(splitVoiceKeys('\x00\x00x').events).toHaveLength(2);
    // Releases of other keys never reach Ink: Ctrl+C, arrows, Escape, letters.
    expect(splitVoiceKeys('\x1b[99;5:3u\x1b[1;1:3A\x1b[27;1:3u\x1b[97;1:3uhi').text).toBe('hi');
    // Presses and repeats stay.
    expect(splitVoiceKeys('\x1b[1;5A\x1b[1;1:2B\x1b[99;5u').text).toBe('\x1b[1;5A\x1b[1;1:2B\x1b[99;5u');
  });
});

describe('push-to-talk', () => {
  let now = 0;
  let ptt: PushToTalk;
  let log: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    ptt = new PushToTalk(() => now);
    log = [];
    for (const e of ['start', 'toggled', 'stop']) ptt.on(e, () => log.push(e));
  });
  afterEach(() => vi.useRealTimers());
  const at = (ms: number, ev: VoiceKeyEvent) => {
    vi.advanceTimersByTime(ms - now);
    now = ms;
    ptt.key(ev);
  };
  const legacy: VoiceKeyEvent = {kind: 'press', protocol: 'legacy'};

  it('legacy hold: starts at once, stops soon after the key repeats stop', () => {
    at(0, legacy);
    expect(log).toEqual(['start']);
    for (let t = 400; t <= 3000; t += 90) at(t, legacy); // macOS: ~0.4 s delay, then ~90 ms repeats
    expect(log).toEqual(['start']);
    vi.advanceTimersByTime(200);
    expect(log).toEqual(['start']);
    vi.advanceTimersByTime(100);
    expect(log).toEqual(['start', 'stop']);
  });

  it('legacy tap: keeps recording until the next press', () => {
    at(0, legacy);
    vi.advanceTimersByTime(800);
    expect(log).toEqual(['start', 'toggled']);
    at(5000, legacy);
    expect(log).toEqual(['start', 'toggled', 'stop']);
    expect(ptt.recording).toBe(false);
  });

  it('kitty: press starts, release stops; a quick tap toggles', () => {
    at(0, {kind: 'press', protocol: 'kitty'});
    at(600, {kind: 'repeat', protocol: 'kitty'});
    at(2000, {kind: 'release', protocol: 'kitty'});
    expect(log).toEqual(['start', 'stop']);
    log = [];
    at(3000, {kind: 'press', protocol: 'kitty'});
    at(3100, {kind: 'release', protocol: 'kitty'});
    expect(log).toEqual(['start', 'toggled']);
    at(6000, {kind: 'press', protocol: 'kitty'});
    at(6100, {kind: 'release', protocol: 'kitty'});
    expect(log).toEqual(['start', 'toggled', 'stop']);
  });
});
