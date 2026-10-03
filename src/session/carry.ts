import type {Transcript} from './transcript.js';
import {estimateTokens} from './transcript.js';

/**
 * Which tool results travel with the conversation when it moves to a session that hasn't seen them
 * (account/provider switch, failover). Text alone loses what was read, run and changed; carrying
 * every result can blow the budget. So: all of them when they fit, otherwise the compaction model
 * picks the ones the next steps need from a one-line index, and the rest become one-line traces.
 */

/** Tokens of tool results a carry may include (on top of the message text). */
export const CARRY_TOOL_BUDGET = 12_000;
/** Most results the selector may keep, however small. */
const MAX_PICKED = 24;

export type CarriedTool = {key: string; message: number; index: number; label: string; summary: string; ok: boolean; result: string; tokens: number};

/** Picks indices (into the listed tool calls) that the new session needs; may throw. */
export type CarrySelector = (input: {index: string; request: string; budgetTokens: number}) => Promise<number[]>;

export const toolKey = (message: number, index: number) => `${message}:${index}`;

/** Tool calls recorded on messages[from, upTo). */
export function carriedTools(t: Transcript, from: number, upTo: number): CarriedTool[] {
  const out: CarriedTool[] = [];
  t.messages.slice(from, upTo).forEach((m, i) =>
    (m.tools ?? []).forEach((x, j) => out.push({key: toolKey(from + i, j), message: from + i, index: j, label: x.label, summary: x.summary, ok: x.ok, result: x.result, tokens: estimateTokens(x.result)})),
  );
  return out;
}

/** The index the selector sees: one line per call (no result bodies, so it stays cheap). */
export function toolIndex(tools: CarriedTool[]): string {
  return tools
    .map((x, i) => `#${i} ${x.label}(${x.summary.replace(/\s+/g, ' ').slice(0, 120)}) ${x.ok ? 'ok' : 'FAILED'} · ~${x.tokens} tokens · ${x.result.split('\n')[0]?.replace(/\s+/g, ' ').slice(0, 100) ?? ''}`)
    .join('\n');
}

/**
 * Keys of the tool results to carry in full. Everything when it fits the budget; otherwise the
 * selector's picks (in its priority order, trimmed to the budget); without a working selector, the
 * most recent results that fit — recent reads, edits and command output usually matter most.
 */
export async function selectCarriedTools(tools: CarriedTool[], request: string, select?: CarrySelector, budgetTokens = CARRY_TOOL_BUDGET): Promise<{keys: Set<string>; how: 'all' | 'selected' | 'recent' | 'none'}> {
  if (!tools.length) return {keys: new Set(), how: 'none'};
  const total = tools.reduce((n, x) => n + x.tokens, 0);
  if (total <= budgetTokens) return {keys: new Set(tools.map((x) => x.key)), how: 'all'};
  const fit = (order: CarriedTool[]) => {
    const keys = new Set<string>();
    let used = 0;
    for (const x of order) {
      if (keys.size >= MAX_PICKED || used + x.tokens > budgetTokens) continue;
      keys.add(x.key);
      used += x.tokens;
    }
    return keys;
  };
  if (select) {
    try {
      const picked = (await select({index: toolIndex(tools), request, budgetTokens}))
        .filter((i) => Number.isInteger(i) && i >= 0 && i < tools.length)
        .map((i) => tools[i]!);
      if (picked.length) return {keys: fit([...new Set(picked)]), how: 'selected'};
    } catch {
      // fall through to recency
    }
  }
  return {keys: fit([...tools].reverse()), how: 'recent'};
}

/** Parse the selector model's reply: a JSON array of indices (tolerates prose around it). */
export function parseIndices(reply: string): number[] {
  const m = /\[[\d,\s]*\]/.exec(reply);
  if (!m) return [];
  try {
    return (JSON.parse(m[0]) as unknown[]).filter((n): n is number => typeof n === 'number');
  } catch {
    return [];
  }
}
