import {accountName} from './privacy.js';
import type {Account, ModelRef, UsageSnapshot} from '../providers/types.js';
import {catalog} from '../router/catalog.js';
import type {Route} from '../session/engine.js';
import {windowLabel} from '../store/usage.js';

export const modelLabel = (ref: ModelRef) => catalog.get(ref)?.label ?? ref.model;

export const accountLabel = (a: Pick<Account, 'email' | 'id' | 'provider'>) => accountName(a);

/** `sonnet · me@x.com (auto · 0.86)` */
export function routeLabel(route: Route, account: Account, effort?: string): string {
  const why =
    route.reason === 'auto' ? `auto${route.confidence !== undefined ? ` · ${route.confidence.toFixed(2)}` : ''}`
    : route.reason === 'sticky' ? 'auto · stayed'
    : route.reason === 'failover' ? 'failover'
    : route.reason === 'default' ? 'default'
    : route.reason === 'escalated' ? 'escalated: the code check found problems the model left twice'
    : undefined;
  return `${modelLabel(route.ref)}${effort ? ` · effort ${effort}` : ''} · ${accountLabel(account)}${why ? ` (${why})` : ''}`;
}

/** One-line summary of a tool result for the transcript (`Read` → line count, else first line). */
export function toolResultSummary(label: string, result: string): string {
  const lines = result.split('\n');
  if (label === 'Read' && /^\s+\d+\t/.test(lines[0] ?? '')) return `Read ${lines.filter((l) => /^\s+\d+\t/.test(l)).length} lines`;
  if (label === 'List') return `${result.split('\n').length - 1} entries`;
  if (label === 'Search' && result !== 'No matches.') return `${lines.filter((l) => l && !l.startsWith('…')).length} results`;
  const first = lines[0] ?? '';
  return lines.length > 1 ? `${first} … (+${lines.length - 1} lines)` : first;
}

/** ` · auto-approved (0.93 via haiku)` etc. for file-changing tool lines. */
export function approvalNote(approvedBy?: string, judge?: string): string {
  if (approvedBy === 'auto') return ` · auto-approved${judge ? ` (${judge})` : ''}`;
  if (approvedBy === 'bypass') return ' · bypass';
  if (approvedBy === 'session') return ' · allowed for session';
  if (approvedBy === 'scratchpad') return ' · scratchpad';
  if (approvedBy === 'rule') return ' · allowed by rule';
  if (approvedBy === 'hook') return ' · allowed by hook';
  if (approvedBy === 'read-only') return '';
  if (approvedBy === 'user') return judge ? ` · you approved (judge ${judge})` : ' · you approved';
  return '';
}

/** Compaction result lines: headline stats and what triggered it. */
export function compactText(reason: string, r: {summarized: number; summaryTokens: number; model: string; beforeTokens: number; afterTokens: number}, autoPct: number): {stats: string; why: string} {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const change = r.beforeTokens > 0 ? Math.round((r.afterTokens / r.beforeTokens - 1) * 100) : 0;
  const delta = change <= 0 ? `−${-change}%` : `+${change}%`; // tiny conversations can grow slightly
  const stats = `${r.summarized} messages → ${k(r.summaryTokens)}-token summary · context ${k(r.beforeTokens)} → ${k(r.afterTokens)} (${delta}) · ${r.model}`;
  const why =
    reason === 'auto' ? `Auto-compacted at ${autoPct}% of the context window · change it in /settings → Compaction`
    : reason === 'midturn' ? `Compacted mid-task at ${autoPct}% of the context window — the agent carries on from the summary`
    : reason === 'handoff' ? 'Compacted before handing the conversation to another model'
    : reason === 'context' ? "The model's context window was full — compacted, and the agent carries on"
    : 'You ran /compact · the next reply starts from the summary · /context for details';
  return {stats, why};
}

/** "in 2h 5m" / "in 3d 4h" / "now" */
export function relative(ms: number, now = Date.now()): string {
  const d = ms - now;
  if (d <= 0) return 'now';
  const mins = Math.round(d / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function age(ms: number, now = Date.now()): string {
  const mins = Math.round((now - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** Compact usage for the status bar: `5h 12% · weekly 3%`. */
export function usageShort(snap: UsageSnapshot | undefined): string {
  if (!snap?.windows.length) return '';
  return snap.windows.map((w) => `${windowLabel(w.windowMins)} ${Math.round(w.usedPct)}%`).join(' · ');
}
