import React, {useEffect, useState} from 'react';
import {Text} from 'ink';

export type Phase = 'routing' | 'thinking' | 'responding' | 'tool';

const LABEL: Record<Phase, string> = {routing: 'Routing', thinking: 'Thinking', responding: 'Responding', tool: 'Running'};

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
export function Working({startedAt, phase, tool, tokens, queued = 0}: {startedAt: number; phase: Phase; tool?: string; tokens?: {input: number; cached: number; output: number}; queued?: number}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, []);
  const bar = barFrame(tick);
  const label = phase === 'tool' && tool ? `${tool}…` : `${LABEL[phase]}…`;
  const band = tick % (label.length + 8);
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
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
        ({seconds}s{tokens ? ` · ↑ ${kTokens(tokens.input)} ↓ ${kTokens(tokens.output)}` : ''}{queued ? ` · ${queued} queued` : ''} · esc to interrupt · /btw to ask)
      </Text>
    </Text>
  );
}
