import { completeWith, resolveUtilityModel } from '../decider/index.js';
import { catalog } from '../router/catalog.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens, renderForSummary, renderMessages, saveTranscript, scratchDir, summaryForModel } from './transcript.js';
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
const MAP_MAX_PARTS = 40;
const FILE_TOOLS = new Set(['Write', 'Edit', 'Delete']);
/**
 * What the summary covers, part by part (one per message you sent), with the files each part
 * changed: built from the transcript, not by the model, so it stays exact across compactions.
 * The full messages stay in the transcript; the recall tool brings any part back verbatim.
 */
export function summaryMap(messages, upTo) {
    const parts = [];
    for (let i = 0; i < upTo; i++) {
        const m = messages[i];
        if (m.role === 'user' && !m.synthetic)
            parts.push({ from: i + 1, to: i + 1, ask: m.text.replace(/\s+/g, ' ').trim().slice(0, 90), files: new Set() });
        const p = parts.at(-1);
        if (!p)
            continue;
        p.to = i + 1;
        for (const tool of m.tools ?? [])
            if (FILE_TOOLS.has(tool.label) && tool.ok && tool.summary)
                p.files.add(tool.summary.split(' ')[0]);
    }
    if (!parts.length)
        return undefined;
    // Long conversations: keep the first parts and the most recent ones.
    const shown = parts.length > MAP_MAX_PARTS ? [...parts.slice(0, 10), undefined, ...parts.slice(-(MAP_MAX_PARTS - 10))] : parts;
    const lines = shown.map((p) => p ? `#${p.from}-${p.to} "${p.ask}"${p.files.size ? ` · changed ${[...p.files].slice(0, 6).join(', ')}${p.files.size > 6 ? ` +${p.files.size - 6}` : ''}` : ''}` : `… ${parts.length - MAP_MAX_PARTS} more parts`);
    return `EARLIER PARTS OF THIS CONVERSATION (summarized above; the full messages are kept — restore one with recall {from, to}, or find something with recall {query}):\n${lines.join('\n')}`;
}
/** Messages a compaction would fold into the summary (0 = nothing to do). */
export function compactableCount(t, keepRecent = KEEP_RECENT) {
    const from = t.summary?.coversUpTo ?? 0;
    return Math.max(0, t.messages.length - keepRecent - from);
}
/** Estimated tokens the conversation carries: summary + messages after it. */
export function contextTokens(t) {
    return estimateTokens((t.summary?.text ?? '') + renderMessages(t.messages.slice(t.summary?.coversUpTo ?? 0)));
}
/**
 * Summarize `messages[summary.coversUpTo .. len-KEEP_RECENT)` (folding in any previous summary)
 * with the compaction model. Native session refs are dropped so the next turn starts a fresh
 * session from the summary instead of resuming the full history.
 */
export async function compactTranscript(t, cfg, opts = {}) {
    const keep = opts.keepRecent ?? KEEP_RECENT;
    const from = t.summary?.coversUpTo ?? 0;
    const upTo = Math.max(from, t.messages.length - keep);
    if (upTo <= from)
        return { skipped: 'nothing old enough to compact yet' };
    const beforeTokens = contextTokens(t);
    const ref = resolveUtilityModel(cfg.compactionModel, cfg);
    if (!ref)
        throw new Error('no compaction model available');
    let summary = t.summary?.text;
    let start = from;
    while (start < upTo) {
        // Grow the chunk until it hits the token budget (always at least one message).
        let end = start + 1;
        while (end < upTo && estimateTokens(renderForSummary(t.messages.slice(start, end + 1))) < CHUNK_TOKENS)
            end++;
        const chunk = renderForSummary(t.messages.slice(start, end));
        const prompt = `${summary ? `EXISTING SUMMARY (of earlier conversation):\n${summary}\n\nNEW TRANSCRIPT TO FOLD IN:\n` : 'TRANSCRIPT:\n'}${chunk}\n\nWrite the updated summary.`;
        const system = opts.focus?.trim() ? `${SYSTEM}\nThe user asked this summary to focus on: ${opts.focus.trim()}. Keep everything about that in full detail (verbatim where it matters); be brief about the rest.` : SYSTEM;
        summary = (await completeWith(ref, cfg, system, prompt, { timeoutMs: 180_000 })).trim();
        if (!summary)
            throw new Error('compaction model returned an empty summary');
        start = end;
    }
    t.summary = { text: summary, coversUpTo: upTo, map: summaryMap(t.messages, upTo) };
    t.native = {};
    await saveTranscript(t).catch(() => { });
    // The summary as a file too (the session's scratchpad), for you to read or the agent to re-read.
    await mkdir(scratchDir(t.id), { recursive: true })
        .then(() => writeFile(path.join(scratchDir(t.id), 'summary.md'), `# Conversation summary (messages 1-${upTo})\n\n${summaryForModel(t.summary)}\n`))
        .catch(() => { });
    return {
        summarized: upTo - from,
        summaryTokens: estimateTokens(summary),
        model: catalog.get(ref)?.label ?? ref.model,
        beforeTokens,
        afterTokens: contextTokens(t),
    };
}
