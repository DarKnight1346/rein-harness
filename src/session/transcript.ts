import type {DiffLine} from '../tools/diff.js';
import {randomUUID} from 'node:crypto';
import {appendFile, mkdir, readdir, rm} from 'node:fs/promises';
import {createReadStream, existsSync} from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import type {ModelRef} from '../providers/types.js';
import {readJson, writeJson} from '../store/json.js';
import {paths, reinHome} from '../store/paths.js';

export type Message = {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  model?: ModelRef;
  accountId?: string;
  interrupted?: boolean;
  /** Written by Rein, not the user (the nudge to carry on after a mid-turn compaction). */
  synthetic?: boolean;
  /** Tool calls made while producing this reply (kept for the record and for session search). */
  tools?: {label: string; summary: string; ok: boolean; result: string; diff?: DiffLine[]}[];
  /** Images attached to a user message (files in the session's scratch folder). */
  images?: import('../providers/types.js').ImageInput[];
};

/** A native session that has seen `messages[0..coversUpTo)` (or the summary + messages after it). */
export type NativeRef = {provider: string; accountId: string; nativeId: string; coversUpTo: number};

export type Transcript = {
  id: string;
  createdAt: number;
  /** Project directory the conversation ran in (sessions are listed per project). */
  cwd?: string;
  messages: Message[];
  /** Compactor output covering `messages[0..coversUpTo)`. */
  summary?: {text: string; coversUpTo: number};
  /** Keyed by `${provider}:${accountId}`, for resume after restart. */
  native: Record<string, NativeRef>;
  /** Auto-routing task tag (one line), set by the router. */
  taskTag?: string;
  /** The agent's task list (todo_write). */
  todos?: import('../tools/todo.js').Todo[];
  /** Standing objective set with /goal. */
  goal?: import('../goals/manager.js').Goal;
  /** Subagents spawned in this conversation (task, model, outcome, tool calls). */
  subagents?: {
    id: number;
    name: string;
    task: string;
    mode: string;
    model?: string;
    status: string;
    output: string;
    rounds: number;
    startedAt: number;
    endedAt?: number;
    tools: {label: string; summary: string; ok?: boolean}[];
  }[];
  /** Token totals for this conversation (all calls, all providers). */
  tokens?: {uncached: number; cached: number; output: number};
};

export function newTranscript(): Transcript {
  return {
    id: `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${randomUUID().slice(0, 8)}`,
    createdAt: Date.now(),
    cwd: process.cwd(),
    messages: [],
    native: {},
  };
}

/** Per-session scratchpad for the agent (temporary files outside the project). */
export const scratchDir = (id: string) => path.join(reinHome(), 'scratch', id);

/*
 * Storage: `sessions/<id>.jsonl` is append-only — one `{"t":"msg","i":N,...}` line per message plus
 * `{"t":"meta",...}` lines whenever summary/native refs/tokens/subagents change (later lines win).
 * `sessions/<id>.meta.json` is a small index entry for listing. Saving appends only what's new, so a
 * long conversation never gets rewritten; search and paging stream the JSONL instead of parsing it.
 * Legacy `<id>.json` files are converted on first load/list.
 */
const jsonlFile = (id: string) => path.join(paths.sessions(), `${id}.jsonl`);
const indexFile = (id: string) => path.join(paths.sessions(), `${id}.meta.json`);
const legacyFile = (id: string) => path.join(paths.sessions(), `${id}.json`);
export const sessionLog = jsonlFile;

/** What's already on disk for a transcript object (messages written, last meta written). */
const persisted = new WeakMap<Transcript, {count: number; meta: string}>();
/** Serialize appends per session (engine + subagent saves can overlap). */
const writing = new Map<string, Promise<void>>();

function metaOf(t: Transcript) {
  const {messages: _m, ...meta} = t;
  return meta;
}

function indexOf(t: Transcript): SessionInfo {
  const firstUser = t.messages.find((m) => m.role === 'user')?.text ?? '';
  return {
    id: t.id,
    cwd: t.cwd,
    createdAt: t.createdAt,
    updatedAt: Math.max(t.createdAt, ...t.messages.map((m) => m.at)),
    messages: t.messages.length,
    title: firstUser.replace(/<skill[^>]*>[\s\S]*?<\/skill>\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(untitled)',
    models: [...new Set(t.messages.flatMap((m) => (m.model ? [m.model.model] : [])))],
    summarized: !!t.summary,
  };
}

export function saveTranscript(t: Transcript): Promise<void> {
  if (!t.messages.length) return Promise.resolve();
  const prev = writing.get(t.id) ?? Promise.resolve();
  const next = prev.then(() => appendNew(t)).catch(() => {});
  writing.set(t.id, next);
  return next;
}

async function appendNew(t: Transcript): Promise<void> {
  await mkdir(paths.sessions(), {recursive: true, mode: 0o700});
  const state = persisted.get(t) ?? {count: 0, meta: ''};
  const lines: string[] = [];
  for (let i = state.count; i < t.messages.length; i++) lines.push(JSON.stringify({t: 'msg', i, ...t.messages[i]}));
  const meta = JSON.stringify(metaOf(t));
  if (meta !== state.meta) lines.push(JSON.stringify({t: 'meta', ...metaOf(t)}));
  if (!lines.length) return;
  await appendFile(jsonlFile(t.id), lines.join('\n') + '\n', {mode: 0o600});
  persisted.set(t, {count: t.messages.length, meta});
  await writeJson(indexFile(t.id), indexOf(t));
}

/**
 * /rewind: drop messages from `to` on. The log keeps every earlier line (history is never lost);
 * a `truncate` marker makes loading stop there, and new messages reuse those indices.
 */
export function truncateTranscript(t: Transcript, to: number): Promise<void> {
  t.messages.length = Math.min(t.messages.length, to);
  const prev = writing.get(t.id) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      await mkdir(paths.sessions(), {recursive: true, mode: 0o700});
      await appendFile(jsonlFile(t.id), JSON.stringify({t: 'truncate', to}) + '\n', {mode: 0o600});
      const state = persisted.get(t);
      persisted.set(t, {count: Math.min(state?.count ?? 0, to), meta: state?.meta ?? ''});
    })
    .then(() => appendNew(t))
    .catch(() => {});
  writing.set(t.id, next);
  return next;
}

/** Stream a session's JSONL into a transcript (meta lines folded in order). */
async function readJsonl(id: string): Promise<Transcript | undefined> {
  if (!existsSync(jsonlFile(id))) return undefined;
  const t = {id, createdAt: 0, messages: [], native: {}} as Transcript;
  const rl = readline.createInterface({input: createReadStream(jsonlFile(id), {encoding: 'utf8'}), crlfDelay: Infinity});
  for await (const line of rl) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line from a crash
    }
    if (rec.t === 'msg') {
      const {t: _t, i, ...m} = rec;
      t.messages[i] = m;
    } else if (rec.t === 'truncate') {
      t.messages.length = Math.min(t.messages.length, rec.to); // /rewind (older lines stay in the log)
    } else if (rec.t === 'meta') {
      const {t: _t, ...meta} = rec;
      Object.assign(t, meta);
    }
  }
  t.messages = t.messages.filter(Boolean);
  persisted.set(t, {count: t.messages.length, meta: JSON.stringify(metaOf(t))});
  return t;
}

/** One-time conversion of a legacy `<id>.json` transcript. */
async function migrate(id: string): Promise<Transcript | undefined> {
  const legacy = await readJson<Transcript | undefined>(legacyFile(id), undefined).catch(() => undefined);
  if (!legacy?.messages) return undefined;
  await saveTranscript(legacy);
  await rm(legacyFile(id), {force: true});
  return legacy;
}

export async function loadTranscript(id: string): Promise<Transcript | undefined> {
  if (!/^[\w-]+$/.test(id)) return undefined;
  return (await readJsonl(id)) ?? (await migrate(id));
}

export type SessionInfo = {id: string; cwd?: string; createdAt: number; updatedAt: number; messages: number; title: string; models: string[]; summarized: boolean};

/**
 * Saved conversations, newest first; `cwd` filters to one project. Reads only the small index
 * files. Every message is kept on disk (compaction only adds a summary).
 */
export async function listTranscripts(opts: {cwd?: string; limit?: number} = {}): Promise<SessionInfo[]> {
  let files: string[];
  try {
    files = await readdir(paths.sessions());
  } catch {
    return [];
  }
  for (const f of files.filter((x) => x.endsWith('.json') && !x.endsWith('.meta.json'))) await migrate(f.slice(0, -5));
  const out: SessionInfo[] = [];
  for (const f of (await readdir(paths.sessions())).filter((x) => x.endsWith('.meta.json'))) {
    const info = await readJson<SessionInfo | undefined>(path.join(paths.sessions(), f), undefined).catch(() => undefined);
    if (!info?.messages) continue;
    if (opts.cwd && info.cwd && path.resolve(info.cwd) !== path.resolve(opts.cwd)) continue;
    out.push(info);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export async function loadLatestTranscript(): Promise<Transcript | undefined> {
  const [latest] = await listTranscripts({limit: 1});
  return latest ? loadTranscript(latest.id) : undefined;
}

/** Rough token estimate (≈4 chars/token); used only for budgeting, never for billing. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function renderMessages(messages: Message[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}${m.images?.length ? `\n[attached image${m.images.length > 1 ? 's' : ''}: ${m.images.map((i) => i.path).join(', ')}]` : ''}${m.interrupted ? ' [interrupted]' : ''}`)
    .join('\n\n');
}

/**
 * Messages for the compaction model: the text plus a one-line trace per tool call with a short
 * excerpt of its result, so a summary of a tool-heavy turn knows what was read, run and changed.
 */
export function renderForSummary(messages: Message[]): string {
  return messages
    .map((m) => {
      const tools = (m.tools ?? []).map((c) => {
        const excerpt = c.result.slice(0, 300).replace(/\s+/g, ' ');
        const more = c.result.length > 300 ? ` … [excerpt; full result ${c.result.split('\n').length} lines, ${c.result.length} chars]` : '';
        return `[tool ${c.label}(${c.summary}) ${c.ok ? '✓' : '✗'}] ${excerpt}${more}`;
      });
      return renderMessages([m]) + (tools.length ? `\n${tools.join('\n')}` : '');
    })
    .join('\n\n');
}

/** First message a carry for a session covering messages[0, coversUpTo) starts from. */
export function carryStart(t: Transcript, coversUpTo: number): number {
  return t.summary && coversUpTo < t.summary.coversUpTo ? t.summary.coversUpTo : coversUpTo;
}

/**
 * Messages with their tool calls: results whose key (`message:index`) is in `keep` are included in
 * full, the rest as one-line traces, so a new session knows what was read, run and changed.
 */
function renderWithTools(messages: Message[], from: number, keep: ReadonlySet<string>): string {
  return messages
    .map((m, i) => {
      const tools = (m.tools ?? []).map((x, j) =>
        keep.has(`${from + i}:${j}`) ? `[tool ${x.label}(${x.summary}) ${x.ok ? 'result' : 'FAILED'}:\n${x.result}\n]` : `[tool ${x.label}(${x.summary}) ${x.ok ? '✓' : '✗ failed'}]`,
      );
      const body = [...tools, m.text].filter(Boolean).join('\n');
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${body}${m.images?.length ? `\n[attached image${m.images.length > 1 ? 's' : ''}: ${m.images.map((im) => im.path).join(', ')}]` : ''}${m.interrupted ? ' [interrupted]' : ''}`;
    })
    .join('\n\n');
}

/**
 * Context to prepend when a native session hasn't seen part of the conversation (new session,
 * account failover, provider switch). `keep` = tool results to include in full (see carry.ts);
 * `overBudget` is judged on the conversation text alone. Returns '' when nothing is missing.
 */
export function buildCarry(t: Transcript, coversUpTo: number, upTo: number, budgetTokens: number, keep: ReadonlySet<string> = new Set()): {text: string; overBudget: boolean} {
  const summary = t.summary && coversUpTo < t.summary.coversUpTo ? t.summary : undefined;
  const from = carryStart(t, coversUpTo);
  const missing = t.messages.slice(from, upTo);
  if (!summary && !missing.length) return {text: '', overBudget: false};
  const head = [
    '<earlier_conversation>',
    'This conversation started before you joined it (another model or session). Continue it naturally; do not mention the handoff. Tool calls you see here were made by you earlier; results not shown in full can be re-read if needed.',
    summary ? `<summary>\n${summary.text}\n</summary>` : '',
  ].filter(Boolean);
  const textOnly = [...head, missing.length ? renderWithTools(missing, from, new Set()) : '', '</earlier_conversation>'].filter(Boolean).join('\n\n');
  const text = [...head, missing.length ? renderWithTools(missing, from, keep) : '', '</earlier_conversation>'].filter(Boolean).join('\n\n') + '\n\n';
  return {text, overBudget: estimateTokens(textOnly) > budgetTokens};
}
