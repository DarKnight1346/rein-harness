import {createHash} from 'node:crypto';
import {closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {Config} from '../store/config.js';
import {reinHome} from '../store/paths.js';
import type {ToolDef} from '../tools/registry.js';
import {run} from '../util/proc.js';
import {SKIP, SOURCE} from './repoMap.js';

/**
 * Local semantic index (/index, semantic_search): the project's source and docs in ~60-line chunks,
 * embedded by a local Ollama model, for search by meaning ("where do we retry failed charges?").
 * Git-aware and incremental: a file is embedded again only when its git blob (or, if changed in the
 * working tree, its content hash) changes, and files git ignores are never read. Nothing leaves the
 * machine. Without Ollama it says so and does nothing.
 */
/** `remote: true` allows an Ollama that isn't on this machine (your code is sent to it to embed). */
export type SemanticConfig = {model?: string; url?: string; remote?: boolean};
type Chunk = {start: number; end: number; v: string}; // v: base64 Float32Array
type FileEntry = {key: string; chunks: Chunk[]};
type Index = {model: string; built: string; files: Record<string, FileEntry>};
export type SemanticHit = {file: string; start: number; end: number; score: number; text: string};

export const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_URL = 'http://127.0.0.1:11434';
const CHUNK_LINES = 60;
const OVERLAP = 10;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 20_000;
const BATCH = 32;
const DOCS = /\.(?:md|mdx|rst|txt|sql|proto|graphql)$/i;

let fetcher: typeof fetch = (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(120_000)});
/** Tests swap Ollama for a fake. */
export function setEmbedFetch(fn: typeof fetch): void {
  fetcher = fn;
}

const opts = (c?: SemanticConfig) => ({model: c?.model || DEFAULT_MODEL, url: (c?.url || DEFAULT_URL).replace(/\/+$/, '')});
export const indexFile = (root: string) => path.join(reinHome(), 'index', `${createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 16)}.json`);

/** Only an Ollama on this machine, unless the config says otherwise: what's embedded is your code. */
export function localUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

async function embed(c: SemanticConfig | undefined, input: string[]): Promise<Float32Array[]> {
  const {model, url} = opts(c);
  if (!localUrl(url) && !c?.remote) throw new Error(`${url} isn't on this machine, and embedding sends it your code: set "remote": true in semanticIndex to allow it`);
  let r: Response;
  try {
    r = await fetcher(`${url}/api/embed`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model, input})});
  } catch {
    throw new Error(`Ollama isn't running at ${url}. Install it from https://ollama.com, then: ollama pull ${model}`);
  }
  if (r.status === 404) throw new Error(`Ollama doesn't have ${model}: run ollama pull ${model}`);
  if (!r.ok) throw new Error(`Ollama answered ${r.status}`);
  const j = (await r.json()) as {embeddings?: number[][]};
  if (!j.embeddings || j.embeddings.length !== input.length) throw new Error('unexpected answer from Ollama');
  return j.embeddings.map((e) => normalize(Float32Array.from(e)));
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}
const pack = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
const unpack = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

const cache = new Map<string, {mtime: number; index: Index}>();
/** The project's index, parsed once per change of the file. */
export function loadIndex(root: string): Index | undefined {
  const f = indexFile(root);
  let fd: number | undefined;
  try {
    // One handle for the check and the read, so the file can't change in between.
    fd = openSync(f, 'r');
    const mtime = fstatSync(fd).mtimeMs;
    const hit = cache.get(f);
    if (hit?.mtime === mtime) return hit.index;
    const index = JSON.parse(readFileSync(fd, 'utf8')) as Index;
    cache.set(f, {mtime, index});
    return index;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The files to index with a change key each: the git blob, or a content hash when changed in the working tree. */
async function tracked(root: string): Promise<Map<string, string>> {
  const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 60_000}).catch(() => undefined))?.stdout ?? '';
  const out = new Map<string, string>();
  for (const line of (await git('ls-files', '-s', '-z')).split('\0')) {
    const m = line.match(/^\d+ ([0-9a-f]+) \d\t(.+)$/);
    if (m && (SOURCE.test(m[2]!) || DOCS.test(m[2]!)) && !SKIP.test(m[2]!)) out.set(m[2]!, m[1]!);
  }
  // Changed or new (not ignored) files: key by what's on disk now.
  const dirty = (await git('ls-files', '-m', '-o', '--exclude-standard', '-z')).split('\0').filter((f) => f && (SOURCE.test(f) || DOCS.test(f)) && !SKIP.test(f));
  for (const f of dirty) {
    try {
      out.set(f, `wt:${createHash('sha1').update(readFileSync(path.join(root, f))).digest('hex')}`);
    } catch {
      out.delete(f); // deleted in the working tree
    }
  }
  return new Map([...out].slice(0, MAX_FILES));
}

function chunks(text: string): {start: number; end: number; text: string}[] {
  const lines = text.split('\n');
  const out: {start: number; end: number; text: string}[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES - OVERLAP) {
    const part = lines.slice(i, i + CHUNK_LINES);
    if (part.join('').trim()) out.push({start: i + 1, end: i + part.length, text: part.join('\n')});
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return out;
}

export type BuildResult = {files: number; embedded: number; removed: number; chunks: number};

/** Builds or updates the index: unchanged files keep their vectors, changed ones are embedded again, gone ones dropped. */
export async function buildIndex(root: string, c?: SemanticConfig, onProgress?: (done: number, total: number) => void): Promise<BuildResult> {
  const {model} = opts(c);
  const files = await tracked(root);
  if (!files.size) throw new Error('nothing to index: not a git repo, or no source or docs files');
  const old = loadIndex(root);
  const prev = old?.model === model ? old.files : {};
  const next: Record<string, FileEntry> = {};
  const todo: {file: string; key: string; parts: {start: number; end: number; text: string}[]}[] = [];
  for (const [file, key] of files) {
    if (prev[file]?.key === key) next[file] = prev[file]!;
    else {
      try {
        if (statSync(path.join(root, file)).size > MAX_FILE_BYTES) continue;
        const text = readFileSync(path.join(root, file), 'utf8');
        if (text.includes('\0')) continue;
        todo.push({file, key, parts: chunks(text)});
      } catch {}
    }
  }
  const queue = todo.flatMap((t) => t.parts.map((p) => ({t, p})));
  const vectors = new Map<object, Float32Array>();
  for (let i = 0; i < queue.length; i += BATCH) {
    const batch = queue.slice(i, i + BATCH);
    // The path is part of what's embedded: "billing/retry.ts" says a lot about its content.
    const vs = await embed(c, batch.map(({t, p}) => `${t.file}\n${p.text}`));
    batch.forEach(({p}, j) => vectors.set(p, vs[j]!));
    onProgress?.(Math.min(i + BATCH, queue.length), queue.length);
  }
  for (const t of todo) next[t.file] = {key: t.key, chunks: t.parts.map((p) => ({start: p.start, end: p.end, v: pack(vectors.get(p)!)}))};
  mkdirSync(path.dirname(indexFile(root)), {recursive: true});
  writeFileSync(indexFile(root), JSON.stringify({model, built: new Date().toISOString(), files: next} satisfies Index));
  const removed = Object.keys(prev).filter((f) => !next[f]).length;
  return {files: Object.keys(next).length, embedded: todo.length, removed, chunks: Object.values(next).reduce((n, f) => n + f.chunks.length, 0)};
}

/** The chunks closest in meaning to the query (cosine similarity), with their current text. */
export async function semanticSearch(root: string, c: SemanticConfig | undefined, query: string, k = 10): Promise<SemanticHit[]> {
  const index = loadIndex(root);
  if (!index) throw new Error('no semantic index for this project yet: run /index');
  if (index.model !== opts(c).model) throw new Error(`the index was built with ${index.model}: run /index again for ${opts(c).model}`);
  const [q] = await embed(c, [query]);
  const scored: {file: string; start: number; end: number; score: number}[] = [];
  for (const [file, f] of Object.entries(index.files))
    for (const ch of f.chunks) {
      const v = unpack(ch.v);
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i]! * q![i]!;
      scored.push({file, start: ch.start, end: ch.end, score: s});
    }
  scored.sort((a, b) => b.score - a.score);
  const out: SemanticHit[] = [];
  for (const h of scored) {
    if (out.length >= k) break;
    if (out.some((o) => o.file === h.file && h.start <= o.end && o.start <= h.end)) continue; // overlapping windows
    let text = '';
    try {
      text = readFileSync(path.join(root, h.file), 'utf8').split('\n').slice(h.start - 1, h.end).join('\n');
    } catch {}
    out.push({...h, text});
  }
  return out;
}

export function formatSemanticHits(hits: SemanticHit[], lines = 12): string {
  if (!hits.length) return 'No matches.';
  return hits.map((h) => `${h.file}:${h.start}-${h.end}  (${h.score.toFixed(2)})\n${h.text.split('\n').slice(0, lines).map((l) => `  ${l}`).join('\n')}`).join('\n\n');
}

export function semanticSearchTool(config: () => Config, root: () => string): ToolDef {
  return {
    name: 'semantic_search',
    label: 'SemanticSearch',
    description: '',
    describe: () =>
      'Search this project by meaning, not exact text: "where do we retry failed payments", "the code that decides who can see an invoice". Returns the closest ~60-line chunks with file:line ranges and their first lines. Use search (ripgrep) when you know the identifier or string.',
    inputSchema: {type: 'object', properties: {query: {type: 'string', description: 'What you are looking for, in words'}, k: {type: 'integer', description: 'How many chunks (default 8, at most 30)'}}, required: ['query']},
    mutating: false,
    // Offered once semanticIndex is configured and this project has an index.
    enabled: () => !!config().semanticIndex && existsSync(indexFile(root())),
    summarize: (a) => String(a?.query ?? '').slice(0, 80),
    async run(_ctx, args) {
      const hits = await semanticSearch(root(), config().semanticIndex, String(args?.query ?? ''), Math.min(30, Math.max(1, Number(args?.k) || 8)));
      return {ok: true, text: formatSemanticHits(hits)};
    },
  };
}
