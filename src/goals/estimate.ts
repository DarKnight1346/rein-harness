import {listTranscripts, loadTranscript} from '../session/transcript.js';

export type GoalEstimate = {median: number; low: number; high: number; n: number};

/**
 * What a goal here usually costs: the median (and range) of goals finished in this project's
 * recent conversations, at API list prices. Undefined until a few have finished: a guess from
 * one goal would mislead more than it helps.
 */
export async function estimateGoalCost(cwd = process.cwd(), opts: {limit?: number; minGoals?: number} = {}): Promise<GoalEstimate | undefined> {
  const costs: number[] = [];
  for (const s of await listTranscripts({cwd, limit: opts.limit ?? 50})) {
    const g = (await loadTranscript(s.id).catch(() => undefined))?.goal;
    if (g?.status === 'done' && g.startUsd !== undefined && g.endUsd !== undefined && g.endUsd >= g.startUsd) costs.push(g.endUsd - g.startUsd);
  }
  if (costs.length < (opts.minGoals ?? 3)) return undefined;
  costs.sort((a, b) => a - b);
  const mid = costs.length >> 1;
  const median = costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
  return {median, low: costs[0]!, high: costs.at(-1)!, n: costs.length};
}
