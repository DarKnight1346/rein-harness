import type {ModelRef, TokenCount} from './types.js';

/**
 * One-off model calls (compaction, the decision model, the advisor, reviews, web_fetch) report what
 * they used here, so a conversation's totals include them. Before this they were counted nowhere:
 * an advisor call on the priciest model looked free.
 */
type Listener = (ref: ModelRef, tokens: TokenCount) => void;
const listeners = new Set<Listener>();

export function onSideUsage(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function reportSideUsage(ref: ModelRef, tokens: TokenCount | undefined): void {
  if (!tokens || !(tokens.input || tokens.output)) return;
  for (const l of listeners) l(ref, tokens);
}
