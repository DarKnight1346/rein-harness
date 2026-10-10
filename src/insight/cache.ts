import path from 'node:path';
import {listTranscripts, loadTranscript, type Transcript} from '../session/transcript.js';

/**
 * Prompt-cache analytics (/cache): how much of each turn's input was read from the provider's prompt
 * cache, and what made it cold — a first message, a compaction or rewind, a switch of account,
 * provider or model, a fresh native session that carried the context over, or an idle gap past the
 * cache's lifetime. From the per-reply record the engine keeps (conversations since this was added).
 */
export type CacheTurn = {conversation: string; at: number; model: string; input: number; cached: number; cold?: string};

export function cacheTurns(t: Transcript): CacheTurn[] {
  return t.messages
    .filter((m) => m.role === 'assistant' && m.cache && m.cache.input > 0)
    .map((m) => ({conversation: t.id, at: m.at, model: m.model ? `${m.model.provider}:${m.model.model}` : 'unknown', input: m.cache!.input, cached: m.cache!.cached, ...(m.cache!.cold ? {cold: m.cache!.cold} : {})}));
}

export async function collectCache(opts: {cwd?: string; days?: number} = {}): Promise<{turns: CacheTurn[]; scope: string}> {
  const since = Date.now() - (opts.days ?? 30) * 86_400_000;
  const turns: CacheTurn[] = [];
  for (const info of (await listTranscripts(opts.cwd ? {cwd: opts.cwd} : {})).filter((s) => s.updatedAt >= since)) {
    const t = await loadTranscript(info.id).catch(() => undefined);
    if (t) turns.push(...cacheTurns(t).filter((x) => x.at >= since));
  }
  return {turns, scope: opts.cwd ? path.basename(opts.cwd) : 'all projects'};
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
/** "idle 73 min (past the cache lifetime)" → "idle past the cache lifetime", for grouping. */
const group = (reason: string) => reason.replace(/^idle \d+ min/, 'idle');

export function formatCache(turns: CacheTurn[], days: number, scope: string): string {
  if (!turns.length) return `No prompt-cache data in the last ${days} days (${scope}). It's recorded for turns from this version of Rein on.`;
  const input = turns.reduce((n, t) => n + t.input, 0);
  const cached = turns.reduce((n, t) => n + t.cached, 0);
  const byModel = new Map<string, CacheTurn[]>();
  for (const t of turns) byModel.set(t.model, [...(byModel.get(t.model) ?? []), t]);
  const cold = new Map<string, {turns: number; uncached: number}>();
  for (const t of turns) {
    // A turn counts as broken when it says why, or when it read under half its input from the cache with no known reason.
    const reason = t.cold ? group(t.cold) : t.cached < t.input / 2 ? 'unexplained (the system prompt or tools changed, or the provider evicted it)' : undefined;
    if (!reason) continue;
    const c = cold.get(reason) ?? {turns: 0, uncached: 0};
    c.turns++;
    c.uncached += t.input - t.cached;
    cold.set(reason, c);
  }
  return [
    `Prompt cache, last ${days} days (${scope}): ${pct(cached, input)} of ${k(input)} input tokens read from the cache, over ${turns.length} turns`,
    'By model:',
    ...[...byModel].sort((a, b) => b[1].length - a[1].length).map(([m, ts]) => `  ${m.padEnd(28)} ${pct(ts.reduce((n, t) => n + t.cached, 0), ts.reduce((n, t) => n + t.input, 0))} cached · ${ts.length} turns`),
    ...(cold.size
      ? ['What made it cold (turns, input tokens not cached):', ...[...cold].sort((a, b) => b[1].uncached - a[1].uncached).map(([r, c]) => `  ${r.padEnd(44)} ${String(c.turns).padStart(4)} turns  ${k(c.uncached).padStart(6)}`)]
      : ['Nothing broke the cache.']),
  ].join('\n');
}
