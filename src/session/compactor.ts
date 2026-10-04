import {completeWith, resolveUtilityModel} from '../decider/index.js';
import {catalog} from '../router/catalog.js';
import type {Config} from '../store/config.js';
import {estimateTokens, renderForSummary, renderMessages, saveTranscript, type Transcript} from './transcript.js';

const SYSTEM = `You compress chat transcripts into a summary another assistant will use to continue the conversation seamlessly.
Write in plain text with these sections (omit empty ones):
GOAL: what the user is trying to accomplish.
KEY FACTS & DECISIONS: everything established so far, including names, numbers, file paths, code identifiers and exact values (verbatim).
USER PREFERENCES: tone, format, constraints the user asked for.
CODE & ARTIFACTS: essential code or text produced, verbatim if short, otherwise its gist and key signatures.
OPEN QUESTIONS / NEXT STEPS: what was pending when the transcript ends. If it ends in the middle of a task, say exactly where the work stopped and what the next step is.
Be dense and specific. No preamble, no commentary about the summary itself.`;

/** Messages kept verbatim after the summary (the last couple of turns). */
const KEEP_RECENT = 4;
/** Max transcript tokens sent per compaction call; longer histories are folded in chunks. */
const CHUNK_TOKENS = 60_000;

export type CompactResult =
  | {
      summarized: number;
      summaryTokens: number;
      model: string;
      /** Estimated conversation context before / after (summary + messages after it). */
      beforeTokens: number;
      afterTokens: number;
    }
  | {skipped: string};

/** `midturn`: the context filled up while the agent was working; it carries on from the summary. */
export type CompactReason = 'manual' | 'auto' | 'midturn' | 'handoff' | 'context';

/** Messages a compaction would fold into the summary (0 = nothing to do). */
export function compactableCount(t: Transcript, keepRecent = KEEP_RECENT): number {
  const from = t.summary?.coversUpTo ?? 0;
  return Math.max(0, t.messages.length - keepRecent - from);
}

/** Estimated tokens the conversation carries: summary + messages after it. */
export function contextTokens(t: Transcript): number {
  return estimateTokens((t.summary?.text ?? '') + renderMessages(t.messages.slice(t.summary?.coversUpTo ?? 0)));
}

/**
 * Summarize `messages[summary.coversUpTo .. len-KEEP_RECENT)` (folding in any previous summary)
 * with the compaction model. Native session refs are dropped so the next turn starts a fresh
 * session from the summary instead of resuming the full history.
 */
export async function compactTranscript(t: Transcript, cfg: Config, opts: {keepRecent?: number} = {}): Promise<CompactResult> {
  const keep = opts.keepRecent ?? KEEP_RECENT;
  const from = t.summary?.coversUpTo ?? 0;
  const upTo = Math.max(from, t.messages.length - keep);
  if (upTo <= from) return {skipped: 'nothing old enough to compact yet'};
  const beforeTokens = contextTokens(t);
  const ref = resolveUtilityModel(cfg.compactionModel, cfg);
  if (!ref) throw new Error('no compaction model available');

  let summary = t.summary?.text;
  let start = from;
  while (start < upTo) {
    // Grow the chunk until it hits the token budget (always at least one message).
    let end = start + 1;
    while (end < upTo && estimateTokens(renderForSummary(t.messages.slice(start, end + 1))) < CHUNK_TOKENS) end++;
    const chunk = renderForSummary(t.messages.slice(start, end));
    const prompt = `${summary ? `EXISTING SUMMARY (of earlier conversation):\n${summary}\n\nNEW TRANSCRIPT TO FOLD IN:\n` : 'TRANSCRIPT:\n'}${chunk}\n\nWrite the updated summary.`;
    summary = (await completeWith(ref, cfg, SYSTEM, prompt, {timeoutMs: 180_000})).trim();
    if (!summary) throw new Error('compaction model returned an empty summary');
    start = end;
  }

  t.summary = {text: summary!, coversUpTo: upTo};
  t.native = {};
  await saveTranscript(t).catch(() => {});
  return {
    summarized: upTo - from,
    summaryTokens: estimateTokens(summary!),
    model: catalog.get(ref)?.label ?? ref.model,
    beforeTokens,
    afterTokens: contextTokens(t),
  };
}
