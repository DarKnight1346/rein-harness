import {existsSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';

/**
 * `@file` mentions: the project's files (ripgrep --files: respects .gitignore, skips hidden), a
 * fuzzy ranking for the autocomplete, and what a mention attaches when the message is sent.
 */
const MAX_FILES = 50_000;
const REFRESH_MS = 30_000;

let cache: {root: string; at: number; files: string[]; dirs: string[]} | undefined;
let loading: Promise<void> | undefined;

/** Kick off / refresh the file index (cheap; called when an `@` is typed). */
export function primeFiles(root: string): Promise<void> {
  if (loading) return loading;
  if (cache?.root === root && Date.now() - cache.at < REFRESH_MS) return Promise.resolve();
  loading = (async () => {
    const rg = await ripgrep();
    let files: string[] = [];
    if (rg) {
      const res = await run(rg, ['--files', '--color', 'never', root], {timeoutMs: 15_000}).catch(() => undefined);
      files = (res?.stdout ?? '').split(/\r?\n/).filter(Boolean).slice(0, MAX_FILES).map((f) => path.relative(root, f));
    }
    const dirs = [...new Set(files.flatMap((f) => {
      const parts = f.split(/[\\/]/).slice(0, -1);
      return parts.map((_, i) => parts.slice(0, i + 1).join('/') + '/');
    }))];
    cache = {root, at: Date.now(), files: files.map((f) => f.replace(/\\/g, '/')), dirs};
  })().finally(() => (loading = undefined));
  return loading;
}

/** Subsequence fuzzy score (higher = better): contiguous runs and basename hits rank first. */
function score(candidate: string, q: string): number {
  if (!q) return 1;
  const c = candidate.toLowerCase();
  const query = q.toLowerCase();
  const base = c.slice(c.lastIndexOf('/', c.length - 2) + 1);
  if (base.startsWith(query)) return 1000 - c.length;
  if (c.includes(query)) return 800 - c.indexOf(query) - c.length / 10;
  let i = 0;
  let s = 0;
  let run = 0;
  for (const ch of c) {
    if (ch === query[i]) {
      i++;
      run++;
      s += run * 2;
      if (i === query.length) return 100 + s - c.length / 10;
    } else run = 0;
  }
  return -1;
}

/** Best matches for the text after `@` (files and folders), up to `limit`. */
export function suggestFiles(root: string, query: string, limit = 8): string[] {
  void primeFiles(root);
  if (!cache || cache.root !== root) return [];
  return [...cache.files, ...cache.dirs]
    .map((f) => ({f, s: score(f, query)}))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.f.length - b.f.length)
    .slice(0, limit)
    .map((x) => x.f);
}

/** The `@query` being typed at the end of the input, if any. */
export function mentionAt(draft: string): {start: number; query: string} | undefined {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  return m ? {start: draft.length - m[1]!.length - 1, query: m[1]!} : undefined;
}

/** Paths mentioned in a message (`@src/a.ts`), resolved against the project, existing only. */
export function mentionedPaths(text: string, root: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@((?:~\/|\/|\.{0,2}\/?)[^\s@]+)/g)) {
    const raw = m[1]!.replace(/[.,;:!?)]+$/, '');
    const abs = raw.startsWith('~/') ? path.join(process.env.HOME ?? '', raw.slice(2)) : path.resolve(root, raw);
    if (existsSync(abs) && !out.includes(abs)) out.push(abs);
  }
  return out;
}

/** A mentioned folder: its entries, so the model knows what's there. */
export function dirListing(abs: string, display: string): string {
  try {
    const entries = readdirSync(abs, {withFileTypes: true}).filter((e) => !e.name.startsWith('.')).slice(0, 200);
    return `<directory path="${display}">\n${entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n')}\n</directory>`;
  } catch (err) {
    return `<directory path="${display}">(could not list: ${(err as Error).message})</directory>`;
  }
}

export const isDirectory = (abs: string) => {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
};
