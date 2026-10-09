import {execFileSync} from 'node:child_process';
import {completeWith, resolveUtilityModel} from '../decider/index.js';
import type {ModelRef} from '../providers/types.js';
import {catalog} from '../router/catalog.js';
import type {Config} from '../store/config.js';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {estimateTokens, renderForSummary, renderMessages, saveTranscript, scratchDir, summaryForModel, type Message, type Transcript} from './transcript.js';

const SYSTEM = `You compress chat transcripts into a summary another assistant will use to continue the conversation seamlessly.
Write in plain text with these sections (omit empty ones):
GOAL: what the user is trying to accomplish.
KEY FACTS & DECISIONS: everything established so far, including names, numbers, file paths, code identifiers and exact values (verbatim).
USER PREFERENCES: tone, format, constraints the user asked for.
CODE & ARTIFACTS: essential code or text produced, verbatim if short, otherwise its gist and key signatures.
OPEN QUESTIONS / NEXT STEPS: what was pending when the transcript ends. If it ends in the middle of a task, say exactly where the work stopped and what the next step is.
Be dense and specific. No preamble, no commentary about the summary itself.`;

/** faithful-compaction: what the summary must keep, on top of SYSTEM. */
const FAITHFUL = `This summary replaces the transcript for an assistant in the middle of a coding task, so it must let the work continue with nothing lost. In addition:
FAILED APPROACHES: what was tried and didn't work, and why, so it isn't tried again.
CURRENT STATE: what passes and what fails right now, with the latest failing test names and error messages verbatim.
Keep exact identifiers, file paths, line numbers, commands and error text. The user's requests and the repository state are attached separately, word for word: don't restate them.`;
/** faithful-compaction: characters of each tool result the summarizer sees (start and end). */
const FAITHFUL_EXCERPT = 4_000;
const FAITHFUL_CHUNK_TOKENS = 150_000;
const MAX_REQUESTS_CHARS = 60_000;

/**
 * faithful-compaction: the parts of the context a summary must not paraphrase, built by Rein: every
 * request the user made, word for word, and the repository's state from git.
 */
function verbatimContext(messages: Message[], upTo: number): string {
  const asks = messages.slice(0, upTo).filter((m) => m.role === 'user' && !m.synthetic && !/^<(context_compacted|code_check|stop_hook)>/.test(m.text));
  let requests = asks.map((m, i) => `--- request ${i + 1} ---\n${m.text}`).join('\n\n');
  if (requests.length > MAX_REQUESTS_CHARS) requests = `${requests.slice(0, MAX_REQUESTS_CHARS / 2)}\n…\n${requests.slice(-MAX_REQUESTS_CHARS / 2)}`;
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, {encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore']}).trim();
    } catch {
      return '';
    }
  };
  const status = git(['status', '--short']);
  const stat = status ? git(['diff', '--stat', 'HEAD']) : '';
  return [
    requests && `THE USER'S REQUESTS, VERBATIM (the summary above only covers the work; these are the exact requirements):\n${requests}`,
    status && `REPOSITORY STATE AT COMPACTION (git status --short; git diff --stat HEAD):\n${status.split('\n').slice(0, 80).join('\n')}${stat ? `\n\n${stat.split('\n').slice(-60).join('\n')}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

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

const MAP_MAX_PARTS = 40;
const FILE_TOOLS = new Set(['Write', 'Edit', 'Delete']);

/**
 * What the summary covers, part by part (one per message you sent), with the files each part
 * changed: built from the transcript, not by the model, so it stays exact across compactions.
 * The full messages stay in the transcript; the recall tool brings any part back verbatim.
 */
export function summaryMap(messages: Message[], upTo: number): string | undefined {
  const parts: {from: number; to: number; ask: string; files: Set<string>}[] = [];
  for (let i = 0; i < upTo; i++) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.synthetic) parts.push({from: i + 1, to: i + 1, ask: m.text.replace(/\s+/g, ' ').trim().slice(0, 90), files: new Set()});
    const p = parts.at(-1);
    if (!p) continue;
    p.to = i + 1;
    for (const tool of m.tools ?? []) if (FILE_TOOLS.has(tool.label) && tool.ok && tool.summary) p.files.add(tool.summary.split(' ')[0]!);
  }
  if (!parts.length) return undefined;
  // Long conversations: keep the first parts and the most recent ones.
  const shown = parts.length > MAP_MAX_PARTS ? [...parts.slice(0, 10), undefined, ...parts.slice(-(MAP_MAX_PARTS - 10))] : parts;
  const lines = shown.map((p) =>
    p ? `#${p.from}-${p.to} "${p.ask}"${p.files.size ? ` · changed ${[...p.files].slice(0, 6).join(', ')}${p.files.size > 6 ? ` +${p.files.size - 6}` : ''}` : ''}` : `… ${parts.length - MAP_MAX_PARTS} more parts`,
  );
  return `EARLIER PARTS OF THIS CONVERSATION (summarized above; the full messages are kept — restore one with recall {from, to}, or find something with recall {query}):\n${lines.join('\n')}`;
}

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
/** faithful-compaction: asks the live session, which holds the whole conversation in its cache, for the summary. */
export type LiveSummarizer = (instructions: string) => Promise<string>;

const LIVE_ASK = (instructions: string) => `<compaction_request>
The conversation is about to be compacted: everything above will be replaced by a summary you write now, so the work can go on in a fresh session. Don't call any tools and don't continue the task; reply with the summary only.
${instructions}
</compaction_request>`;

export async function compactTranscript(t: Transcript, cfg: Config, opts: {keepRecent?: number; focus?: string; model?: ModelRef; live?: LiveSummarizer} = {}): Promise<CompactResult> {
  const keep = opts.keepRecent ?? KEEP_RECENT;
  const from = t.summary?.coversUpTo ?? 0;
  const upTo = Math.max(from, t.messages.length - keep);
  if (upTo <= from) return {skipped: 'nothing old enough to compact yet'};
  const beforeTokens = contextTokens(t);
  const faithful = (cfg.experiments ?? []).includes('faithful-compaction');
  // faithful-compaction: the model doing the work summarizes it, not the cheapest one.
  const ref = (faithful && opts.model && catalog.get(opts.model) ? opts.model : undefined) ?? resolveUtilityModel(cfg.compactionModel, cfg);
  if (!ref) throw new Error('no compaction model available');
  const excerpt = faithful ? FAITHFUL_EXCERPT : undefined;
  const chunkTokens = faithful ? FAITHFUL_CHUNK_TOKENS : CHUNK_TOKENS;

  let summary = t.summary?.text;
  let start = from;
  // The model that did the work, with every tool result in full and its context cached, writes the
  // summary in its own session: better than any excerpt, and about a tenth of the price.
  if (faithful && opts.live) {
    const instructions = `${SYSTEM}\n${FAITHFUL}${opts.focus?.trim() ? `\nFocus on: ${opts.focus.trim()}.` : ''}`;
    const live = await opts.live(LIVE_ASK(instructions)).catch(() => '');
    if (live.trim()) {
      summary = live.trim();
      start = upTo;
    }
  }
  while (start < upTo) {
    // Grow the chunk until it hits the token budget (always at least one message).
    let end = start + 1;
    while (end < upTo && estimateTokens(renderForSummary(t.messages.slice(start, end + 1), excerpt)) < chunkTokens) end++;
    const chunk = renderForSummary(t.messages.slice(start, end), excerpt);
    const prompt = `${summary ? `EXISTING SUMMARY (of earlier conversation):\n${summary}\n\nNEW TRANSCRIPT TO FOLD IN:\n` : 'TRANSCRIPT:\n'}${chunk}\n\nWrite the updated summary.`;
    const base = faithful ? `${SYSTEM}\n${FAITHFUL}` : SYSTEM;
    const system = opts.focus?.trim() ? `${base}\nThe user asked this summary to focus on: ${opts.focus.trim()}. Keep everything about that in full detail (verbatim where it matters); be brief about the rest.` : base;
    summary = (await completeWith(ref, cfg, system, prompt, {timeoutMs: 180_000})).trim();
    if (!summary) throw new Error('compaction model returned an empty summary');
    start = end;
  }

  const map = summaryMap(t.messages, upTo);
  const verbatim = faithful ? verbatimContext(t.messages, upTo) : '';
  t.summary = {text: summary!, coversUpTo: upTo, map: [verbatim, map].filter(Boolean).join('\n\n') || undefined};
  t.native = {};
  await saveTranscript(t).catch(() => {});
  // The summary as a file too (the session's scratchpad), for you to read or the agent to re-read.
  await mkdir(scratchDir(t.id), {recursive: true})
    .then(() => writeFile(path.join(scratchDir(t.id), 'summary.md'), `# Conversation summary (messages 1-${upTo})\n\n${summaryForModel(t.summary!)}\n`))
    .catch(() => {});
  return {
    summarized: upTo - from,
    summaryTokens: estimateTokens(summary!),
    model: catalog.get(ref)?.label ?? ref.model,
    beforeTokens,
    afterTokens: contextTokens(t),
  };
}
