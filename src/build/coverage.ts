import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.js';

/**
 * Coverage of what you changed (/coverage): the lines your working tree adds that the project's last
 * coverage report says no test ran. Reads lcov, Istanbul JSON, Cobertura XML and Go cover profiles,
 * whichever the project produced most recently; it doesn't run the tests itself.
 */
export type LineHits = Map<string, Map<number, number>>;

const REPORTS = ['coverage/lcov.info', 'lcov.info', 'coverage/coverage-final.json', 'coverage-final.json', 'coverage.xml', 'coverage/cobertura-coverage.xml', 'cobertura.xml', 'coverage.out', 'cover.out', 'coverage.txt'];

/** The newest coverage report in the project. */
export function findReport(root: string): string | undefined {
  const found = REPORTS.map((f) => path.join(root, f)).filter((f) => existsSync(f));
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const add = (hits: LineHits, file: string, line: number, n: number) => {
  const m = hits.get(file) ?? new Map<number, number>();
  m.set(line, Math.max(m.get(line) ?? 0, n));
  hits.set(file, m);
};

export function parseCoverage(file: string, text: string): LineHits {
  const hits: LineHits = new Map();
  if (file.endsWith('.info')) {
    let current = '';
    for (const l of text.split('\n')) {
      if (l.startsWith('SF:')) current = l.slice(3).trim();
      else if (l.startsWith('DA:') && current) {
        const [line, n] = l.slice(3).split(',');
        add(hits, current, Number(line), Number(n));
      }
    }
  } else if (file.endsWith('.json')) {
    const j = JSON.parse(text) as Record<string, {path?: string; statementMap?: Record<string, {start: {line: number}}>; s?: Record<string, number>}>;
    for (const [key, f] of Object.entries(j)) for (const [id, loc] of Object.entries(f.statementMap ?? {})) add(hits, f.path ?? key, loc.start.line, f.s?.[id] ?? 0);
  } else if (file.endsWith('.xml')) {
    for (const cls of text.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g))
      for (const ln of cls[2]!.matchAll(/<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g)) add(hits, cls[1]!, Number(ln[1]), Number(ln[2]));
  } else {
    // Go: path/file.go:12.3,14.5 <statements> <count>
    for (const m of text.matchAll(/^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/gm)) for (let l = Number(m[2]); l <= Number(m[3]); l++) add(hits, m[1]!, l, Number(m[4]));
  }
  return hits;
}

/** Lines the working tree adds (vs HEAD), per project-relative file; untracked files count whole. */
export async function addedLinesByFile(root: string): Promise<Map<string, number[]>> {
  const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 30_000}).catch(() => undefined))?.stdout ?? '';
  const out = new Map<string, number[]>();
  let file = '';
  for (const l of (await git('diff', '-U0', '--no-color', 'HEAD')).split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(4).replace(/^b\//, '').trim();
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file && file !== '/dev/null') {
      const start = Number(h[1]);
      const n = h[2] === undefined ? 1 : Number(h[2]);
      out.set(file, [...(out.get(file) ?? []), ...Array.from({length: n}, (_, i) => start + i)]);
    }
  }
  for (const f of (await git('ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean)) {
    try {
      out.set(f, Array.from({length: readFileSync(path.join(root, f), 'utf8').split('\n').length}, (_, i) => i + 1));
    } catch {}
  }
  return out;
}

/** The report's entry for a project file: reports name files absolutely, relative, or by Go import path. */
function entryFor(hits: LineHits, root: string, rel: string): Map<number, number> | undefined {
  const abs = path.join(root, rel);
  for (const [k, v] of hits) if (k === rel || k === abs || path.resolve(root, k) === abs || k.endsWith(`/${rel}`)) return v;
  return undefined;
}

export type Uncovered = {file: string; lines: number[]};

/** Changed lines the report knows about (instrumented) and no test ran. */
export function uncoveredChanges(hits: LineHits, root: string, added: Map<string, number[]>): Uncovered[] {
  const out: Uncovered[] = [];
  for (const [file, lines] of added) {
    const entry = entryFor(hits, root, file);
    if (!entry) continue;
    const missed = lines.filter((l) => entry.get(l) === 0);
    if (missed.length) out.push({file, lines: missed});
  }
  return out;
}

/** 12, 13, 14, 20 → "12-14, 20". */
export const ranges = (lines: number[]) =>
  lines
    .reduce<[number, number][]>((acc, l) => {
      const last = acc.at(-1);
      if (last && l === last[1] + 1) last[1] = l;
      else acc.push([l, l]);
      return acc;
    }, [])
    .map(([a, b]) => (a === b ? String(a) : `${a}-${b}`))
    .join(', ');
