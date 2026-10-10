import React, {useEffect, useState} from 'react';
import {Text} from 'ink';

export type Phase = 'routing' | 'thinking' | 'responding' | 'tool' | 'waiting';

// 'tool': a tool call is running. It shows in the conversation (a pending line with a blinking dot), so
// this line only says the agent is at work, the way Claude Code keeps its spinner word.
const LABEL: Record<Phase, string> = {routing: 'Routing', thinking: 'Thinking', responding: 'Responding', tool: 'Working', waiting: 'Waiting'};

/** On/off every half second while `active`: the dot of a tool call still running. */
export function useBlink(active: boolean): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!active) return;
    setOn(true);
    const t = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(t);
  }, [active]);
  return active && on;
}

/** 59s · 2m 05s · 1h 04m · 2d 3h */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** 1234 → 1.2k */
export const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const TICK_MS = 110;

/** Rein's mark: a 4-cell bar wave whose peak slides back and forth (▇▅▃▁ ▅▇▅▃ ▃▅▇▅ ▁▃▅▇ …). */
const LEVELS = ['▇', '▅', '▃', '▁']; // by distance from the peak
const PEAK = [0, 1, 2, 3, 2, 1];
export const barFrame = (tick: number) =>
  [0, 1, 2, 3].map((cell) => LEVELS[Math.min(3, Math.abs(cell - PEAK[tick % PEAK.length]!))]!);

/** HSL → hex; Ink/chalk downsample hex to 256 colors on terminals without truecolor. */
export function hueHex(h: number, s = 0.85, l = 0.62): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

/** Degrees wrapped into [0, 360) — JS `%` keeps the sign, so long animations went negative. */
const wrapHue = (h: number) => ((h % 360) + 360) % 360;

/** Hue for character `i` at `tick`: a rainbow that flows left→right across bar + label. */
export const rainbow = (i: number, tick: number) => hueHex(wrapHue(i * 24 - tick * 20));

/**
 * Animated status line: sliding bar wave + a rainbow flowing through the bar and the label, with a
 * brighter band sweeping the label. One short line re-rendering at ~9 fps; incremental rendering
 * rewrites only that line.
 */
export function Working({startedAt, phase, tool, tokens, queued = 0, waitUntil}: {startedAt: number; phase: Phase; tool?: string; tokens?: {input: number; cached: number; output: number}; queued?: number; waitUntil?: number}) {
  const [tick, setTick] = useState(0);
  const waiting = phase === 'waiting' && waitUntil !== undefined;
  useEffect(() => {
    // Waiting for a limit can take hours: a still line, refreshed twice a minute (each frame redraws the screen).
    const t = setInterval(() => setTick((n) => n + 1), waiting ? 30_000 : TICK_MS);
    return () => clearInterval(t);
  }, [waiting]);
  if (waiting) {
    const at = new Date(waitUntil);
    const time = at.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    const day = at.toDateString() === new Date().toDateString() ? '' : ` ${at.toLocaleDateString([], {weekday: 'short'})}`;
    return (
      <Text color="yellow">
        ◷ Every account is at its limit · continuing at {time}{day} (in {elapsedText(Math.max(0, waitUntil - Date.now()))}) <Text dimColor>· esc to stop</Text>
      </Text>
    );
  }
  const bar = barFrame(tick);
  const label = phase === 'tool' && tool ? `${tool}…` : `${LABEL[phase]}…`;
  const band = tick % (label.length + 8);
  const elapsed = elapsedText(Date.now() - startedAt);
  return (
    <Text>
      {bar.map((ch, i) => (
        <Text key={`b${i}`} color={rainbow(i, tick)}>
          {ch}
        </Text>
      ))}
      <Text> </Text>
      {[...label].map((ch, i) => {
        const lit = Math.abs(i - band) <= 1;
        return (
          <Text key={i} color={lit ? hueHex(wrapHue(i * 24 - tick * 20 + 96), 1, 0.8) : rainbow(i + 5, tick)} bold={lit}>
            {ch}
          </Text>
        );
      })}
      <Text dimColor>
        {' '}
        ({elapsed}{tokens ? ` · ↑ ${kTokens(tokens.input)} ↓ ${kTokens(tokens.output)}` : ''}{queued ? ` · ${queued} queued` : ''} · esc to interrupt · /btw to ask)
      </Text>
    </Text>
  );
}
