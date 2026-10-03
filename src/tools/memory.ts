import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {ToolError} from './fs.js';
import type {ToolDef} from './registry.js';

/**
 * Project memory: `.rein/MEMORY.md`, one "- fact (date)" line each, loaded into every session in
 * the project. The agent keeps it with `remember` / `forget`; people can edit it like any file.
 */
export const MAX_MEMORY_BYTES = 32 * 1024;
export const memoryFile = (root: string) => path.join(root, '.rein', 'MEMORY.md');

const HEADER = '# Project memory\n\nThings learned while working on this project, kept by Rein (edit freely).\n\n';

export function readMemory(root: string): string {
  try {
    return readFileSync(memoryFile(root), 'utf8');
  } catch {
    return '';
  }
}

/** The remembered facts (bullet lines). */
export const memoryFacts = (root: string) =>
  readMemory(root)
    .split('\n')
    .filter((l) => /^\s*[-*] /.test(l))
    .map((l) => l.replace(/^\s*[-*] /, '').trim());

function save(root: string, facts: string[]): void {
  mkdirSync(path.dirname(memoryFile(root)), {recursive: true});
  writeFileSync(memoryFile(root), HEADER + facts.map((f) => `- ${f}`).join('\n') + (facts.length ? '\n' : ''));
}

export function memoryTools(root: () => string): ToolDef[] {
  return [
    {
      name: 'remember',
      label: 'Remember',
      description: 'Save a fact to project memory.',
      describe: () =>
        "Save a lasting fact about this project to its memory (.rein/MEMORY.md), loaded into every future session here: build/test commands, conventions, architecture decisions, gotchas, the user's stated preferences for this project. One concise fact per call. Not for secrets, temporary state or things obvious from the code.",
      inputSchema: {type: 'object', properties: {fact: {type: 'string', description: 'The fact, one or two sentences'}}, required: ['fact']},
      mutating: false,
      summarize: (a) => String(a?.fact ?? '').replace(/\s+/g, ' ').slice(0, 80),
      async run(_ctx, args) {
        const fact = String(args?.fact ?? '').replace(/\s+/g, ' ').trim();
        if (fact.length < 3) throw new ToolError('fact is required');
        const facts = memoryFacts(root());
        if (facts.some((f) => f.replace(/ \(\d{4}-\d{2}-\d{2}\)$/, '').toLowerCase() === fact.toLowerCase())) return {ok: true, text: 'Already in project memory.'};
        const next = [...facts, `${fact} (${new Date().toISOString().slice(0, 10)})`];
        if (Buffer.byteLength(next.join('\n')) > MAX_MEMORY_BYTES) throw new ToolError('project memory is full (32 KB) — forget outdated facts first');
        save(root(), next);
        return {ok: true, text: `Remembered for this project (${next.length} fact${next.length === 1 ? '' : 's'} in .rein/MEMORY.md).`};
      },
    },
    {
      name: 'forget',
      label: 'Forget',
      description: 'Remove facts from project memory.',
      describe: () => 'Remove outdated or wrong facts from project memory: every fact containing `match` (case-insensitive). The current facts are in your system prompt under "Project memory".',
      inputSchema: {type: 'object', properties: {match: {type: 'string', description: 'Text that identifies the fact(s) to remove'}}, required: ['match']},
      mutating: false,
      summarize: (a) => String(a?.match ?? '').slice(0, 80),
      async run(_ctx, args) {
        const match = String(args?.match ?? '').trim().toLowerCase();
        if (match.length < 3) throw new ToolError('match must be at least 3 characters');
        const facts = memoryFacts(root());
        const keep = facts.filter((f) => !f.toLowerCase().includes(match));
        if (keep.length === facts.length) throw new ToolError(`no fact in project memory contains "${args.match}"`);
        save(root(), keep);
        return {ok: true, text: `Forgot ${facts.length - keep.length} fact${facts.length - keep.length === 1 ? '' : 's'}; ${keep.length} left.`};
      },
    },
  ];
}
