import {readFileSync} from 'node:fs';
import path from 'node:path';
import {formatUsd} from './providers/prices.js';

/**
 * Spending caps in USD at API list prices (see Cost & budgets): per request (everything after one
 * message of yours, Rein's follow-ups included), per goal, and per conversation. Set in
 * ~/.rein/config.json `budget`, or per repo in .rein/settings.json `budget`; where both set one,
 * the lower cap wins.
 */
export type Budget = {requestUsd?: number; goalUsd?: number; conversationUsd?: number};

const KEYS = ['requestUsd', 'goalUsd', 'conversationUsd'] as const;

function fromFile(file: string): Budget {
  try {
    const b = JSON.parse(readFileSync(file, 'utf8'))?.budget;
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

/** The caps in force here: config, the project's .rein/settings.json and settings.local.json; the lowest of each. */
export function effectiveBudget(config: Budget | undefined, root = process.cwd()): Budget {
  const out: Budget = {};
  for (const b of [config ?? {}, fromFile(path.join(root, '.rein', 'settings.json')), fromFile(path.join(root, '.rein', 'settings.local.json'))]) {
    for (const k of KEYS) {
      const v = b[k];
      if (typeof v === 'number' && v > 0) out[k] = Math.min(out[k] ?? Infinity, v);
    }
  }
  return out;
}

export type Spend = {request: number; goal?: number; conversation: number};

/** The first cap the spending has reached, as the message to show (undefined: within budget). */
export function overBudget(spend: Spend, b: Budget): string | undefined {
  const hit = (what: string, spent: number, cap: number | undefined) =>
    cap !== undefined && spent >= cap ? `Budget reached: ${what} has cost ${formatUsd(spent)} of its ${formatUsd(cap)} budget (API list prices), so Rein stopped.` : undefined;
  return (
    hit('this conversation', spend.conversation, b.conversationUsd) ??
    (spend.goal !== undefined ? hit('the goal', spend.goal, b.goalUsd) : undefined) ??
    hit('this request', spend.request, b.requestUsd)
  );
}
