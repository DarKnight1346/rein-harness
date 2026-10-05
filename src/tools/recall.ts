import {renderWithTools, type Transcript} from '../session/transcript.js';
import {ToolError} from './fs.js';
import type {ToolDef} from './registry.js';

const MAX_CHARS = 40_000;

/**
 * `recall` (main agent): bring back part of this conversation that compaction summarized, verbatim:
 * by message number (as the summary's map lists them) or by searching for a word. The messages
 * were never deleted, only left out of the context.
 */
export function recallTool(transcript: () => Transcript | undefined): ToolDef {
  return {
    name: 'recall',
    label: 'Recall',
    description: 'Restore part of this conversation that was summarized (compacted), verbatim.',
    describe: () =>
      "Only after the conversation was compacted (the summary lists EARLIER PARTS by message number): bring a part back verbatim when the summary isn't enough — exact code, an error message, a decision's reasoning. {from, to}: messages by number (up to 30 at a time); {query}: find where something was said (case-insensitive), then recall that range.",
    inputSchema: {
      type: 'object',
      properties: {
        from: {type: 'number', description: 'First message number (1-based, as in the map)'},
        to: {type: 'number', description: 'Last message number'},
        query: {type: 'string', description: 'Text to look for in the summarized part'},
      },
    },
    mutating: false,
    mainOnly: true,
    summarize: (a) => (a?.query ? `"${a.query}"` : `#${a?.from ?? '?'}-${a?.to ?? a?.from ?? '?'}`),
    async run(_ctx, args) {
      const t = transcript();
      const covered = t?.summary?.coversUpTo ?? 0;
      if (!t || !covered) return {ok: false, text: 'Nothing has been summarized in this conversation yet: everything is still in context.'};
      if (typeof args?.query === 'string' && args.query.trim()) {
        const q = args.query.trim().toLowerCase();
        const hits: string[] = [];
        for (let i = 0; i < covered && hits.length < 20; i++) {
          const m = t.messages[i]!;
          const hay = [m.text, ...(m.tools ?? []).map((x) => `${x.label} ${x.summary} ${x.result}`)].join('\n');
          const at = hay.toLowerCase().indexOf(q);
          if (at >= 0) hits.push(`#${i + 1} (${m.role}): …${hay.slice(Math.max(0, at - 80), at + q.length + 120).replace(/\s+/g, ' ')}…`);
        }
        return {ok: true, text: hits.length ? `Found in the summarized part (recall {from, to} for the full messages):\n${hits.join('\n')}` : `"${args.query}" isn't in the summarized part (messages 1-${covered}).`};
      }
      const from = Number(args?.from);
      const to = Number(args?.to ?? args?.from);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) throw new ToolError('give from and to (message numbers, 1-based), or a query');
      if (from > covered) return {ok: false, text: `Messages after #${covered} weren't summarized: they're still in your context.`};
      const end = Math.min(to, covered, from + 29);
      // All tool results in full (that's the point of recalling), clipped overall.
      const slice = t.messages.slice(from - 1, end);
      const keep = new Set(slice.flatMap((m, i) => (m.tools ?? []).map((_x, j) => `${from - 1 + i}:${j}`)));
      let text = renderWithTools(slice, from - 1, keep);
      if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n… [clipped: recall a smaller range]`;
      return {ok: true, text: `Messages #${from}-${end} of this conversation, verbatim:\n\n${text}${end < to ? `\n\n(Up to 30 at a time: recall {from: ${end + 1}, to: ${to}} for the rest.)` : ''}`};
    },
  };
}
