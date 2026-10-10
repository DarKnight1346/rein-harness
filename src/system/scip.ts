import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.js';

/**
 * Cross-repo symbol graph (/symbols): each repo's SCIP index (index.scip, written by scip-typescript,
 * scip-python, scip-java, rust-analyzer, scip-go…), read here with a small protobuf decoder, then
 * joined: a symbol defined in one repo and used in another is the same package and descriptors
 * (the version is left out, since repos pin different versions of a shared library).
 */
export type Occ = {repo: string; file: string; line: number; definition: boolean};
export type SymbolGraph = {defs: Map<string, Occ[]>; refs: Map<string, Occ[]>; names: Map<string, string>; repos: string[]};

// ---------- protobuf, just enough for SCIP ----------

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array, private readonly end = buf.length) {}
  done() {
    return this.pos >= this.end;
  }
  varint(): number {
    let x = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++]!;
      x += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return x;
      shift += 7;
    }
  }
  /** A field: its number, wire type, and a reader of its bytes (length-delimited) or its value. */
  field(): {n: number; wire: number; value: number; bytes?: Uint8Array} {
    const key = this.varint();
    const n = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) return {n, wire, value: this.varint()};
    if (wire === 2) {
      const len = this.varint();
      const bytes = this.buf.subarray(this.pos, this.pos + len);
      this.pos += len;
      return {n, wire, value: len, bytes};
    }
    if (wire === 1) this.pos += 8;
    else if (wire === 5) this.pos += 4;
    return {n, wire, value: 0};
  }
}
const text = (b?: Uint8Array) => (b ? Buffer.from(b).toString('utf8') : '');
const packed = (b?: Uint8Array) => {
  const out: number[] = [];
  if (!b) return out;
  const r = new Reader(b);
  while (!r.done()) out.push(r.varint());
  return out;
};
const firstInt = (b?: Uint8Array) => {
  if (!b) return 0;
  const r = new Reader(b);
  while (!r.done()) {
    const f = r.field();
    if (f.n === 1 && f.wire === 0) return f.value; // SingleLineRange.line / MultiLineRange.start_line
  }
  return 0;
};

export type ScipDoc = {path: string; occurrences: {symbol: string; line: number; roles: number}[]; symbols: {symbol: string; name: string}[]};

/** Index → documents (2) → occurrences (2: range 1 / typed ranges 8–9, symbol 2, roles 3) and symbols (3: symbol 1, display_name 6). */
export function decodeIndex(buf: Uint8Array): ScipDoc[] {
  const docs: ScipDoc[] = [];
  const r = new Reader(buf);
  while (!r.done()) {
    const f = r.field();
    if (f.n !== 2 || !f.bytes) continue;
    const doc: ScipDoc = {path: '', occurrences: [], symbols: []};
    const d = new Reader(f.bytes);
    while (!d.done()) {
      const g = d.field();
      if (g.n === 1) doc.path = text(g.bytes);
      else if (g.n === 2 && g.bytes) {
        const o = new Reader(g.bytes);
        let symbol = '';
        let roles = 0;
        let line: number | undefined;
        while (!o.done()) {
          const h = o.field();
          if (h.n === 1 && h.bytes && line === undefined) line = packed(h.bytes)[0];
          else if ((h.n === 8 || h.n === 9) && h.bytes) line = firstInt(h.bytes); // the typed range wins
          else if (h.n === 2) symbol = text(h.bytes);
          else if (h.n === 3) roles = h.value;
        }
        if (symbol && !symbol.startsWith('local ')) doc.occurrences.push({symbol, line: (line ?? 0) + 1, roles});
      } else if (g.n === 3 && g.bytes) {
        const s = new Reader(g.bytes);
        let symbol = '';
        let name = '';
        while (!s.done()) {
          const h = s.field();
          if (h.n === 1) symbol = text(h.bytes);
          else if (h.n === 6) name = text(h.bytes);
        }
        if (symbol) doc.symbols.push({symbol, name});
      }
    }
    docs.push(doc);
  }
  return docs;
}

/** The symbol without its version: `scheme manager name version descriptors` → `scheme manager name descriptors`. */
export function symbolKey(symbol: string): string {
  const parts = symbol.split(' ');
  return parts.length >= 5 ? [parts[0], parts[1], parts[2], ...parts.slice(4)].join(' ') : symbol;
}

/** A readable name for a symbol: its display name, or the last descriptor (`src/money.ts/format().` → `format`). */
export function shortName(symbol: string): string {
  const d = symbol.split(' ').slice(4).join(' ');
  const m = d.match(/([\w$]+)(?:\([^)]*\))?[#.:/!]?$/);
  return m?.[1] ?? d;
}

export const indexFile = (repo: string) => ['index.scip', path.join('.rein', 'index.scip')].map((f) => path.join(repo, f)).find((f) => existsSync(f));

export function buildSymbolGraph(repos: {name: string; dir: string}[]): SymbolGraph {
  const g: SymbolGraph = {defs: new Map(), refs: new Map(), names: new Map(), repos: []};
  for (const repo of repos) {
    const f = indexFile(repo.dir);
    if (!f) continue;
    g.repos.push(repo.name);
    for (const doc of decodeIndex(readFileSync(f))) {
      for (const s of doc.symbols) if (s.name) g.names.set(symbolKey(s.symbol), s.name);
      for (const o of doc.occurrences) {
        const key = symbolKey(o.symbol);
        const occ: Occ = {repo: repo.name, file: doc.path, line: o.line, definition: (o.roles & 1) === 1};
        const map = occ.definition ? g.defs : g.refs;
        map.set(key, [...(map.get(key) ?? []), occ]);
      }
    }
  }
  return g;
}

/** Symbols whose name matches, with where they're defined and every use, across repos. */
export function lookup(g: SymbolGraph, query: string, max = 10): {key: string; name: string; defs: Occ[]; refs: Occ[]}[] {
  const q = query.toLowerCase();
  const keys = [...new Set([...g.defs.keys(), ...g.refs.keys()])].filter((k) => (g.names.get(k) ?? shortName(k)).toLowerCase() === q || k.toLowerCase().includes(q));
  return keys
    .map((key) => ({key, name: g.names.get(key) ?? shortName(key), defs: g.defs.get(key) ?? [], refs: g.refs.get(key) ?? []}))
    .sort((a, b) => Number(b.defs.length > 0) - Number(a.defs.length > 0) || new Set(b.refs.map((r) => r.repo)).size - new Set(a.refs.map((r) => r.repo)).size)
    .slice(0, max);
}

/** Symbols used in repos other than the one defining them: the seams between repos. */
export function crossRepo(g: SymbolGraph): {key: string; name: string; from: string; usedIn: string[]}[] {
  const out: {key: string; name: string; from: string; usedIn: string[]}[] = [];
  for (const [key, defs] of g.defs) {
    const home = new Set(defs.map((d) => d.repo));
    const usedIn = [...new Set((g.refs.get(key) ?? []).map((r) => r.repo).filter((r) => !home.has(r)))];
    if (usedIn.length) out.push({key, name: g.names.get(key) ?? shortName(key), from: [...home].join(', '), usedIn});
  }
  return out.sort((a, b) => b.usedIn.length - a.usedIn.length);
}

export function formatLookup(rs: ReturnType<typeof lookup>): string {
  if (!rs.length) return 'No symbol by that name in the SCIP indexes.';
  return rs
    .map((r) => [`${r.name}  ${r.key}`, ...r.defs.map((d) => `  defined  ${d.repo}  ${d.file}:${d.line}`), ...r.refs.slice(0, 30).map((x) => `  used     ${x.repo}  ${x.file}:${x.line}`), ...(r.refs.length > 30 ? [`  … ${r.refs.length - 30} more uses`] : [])].join('\n'))
    .join('\n\n');
}

/** Indexers by what the repo has, for `/symbols index` (each skipped when it isn't installed). */
const INDEXERS: {when: string[]; cmd: string; args: string[]}[] = [
  {when: ['tsconfig.json', 'package.json'], cmd: 'scip-typescript', args: ['index']},
  {when: ['pyproject.toml', 'setup.py', 'requirements.txt'], cmd: 'scip-python', args: ['index', '.']},
  {when: ['go.mod'], cmd: 'scip-go', args: []},
  {when: ['Cargo.toml'], cmd: 'rust-analyzer', args: ['scip', '.']},
  {when: ['pom.xml', 'build.gradle', 'build.gradle.kts'], cmd: 'scip-java', args: ['index']},
];

/** Write each repo's index.scip with the indexer for its language, where it's installed. */
export async function indexRepos(repos: {name: string; dir: string}[], log: (line: string) => void): Promise<void> {
  for (const repo of repos) {
    const ix = INDEXERS.find((i) => i.when.some((f) => existsSync(path.join(repo.dir, f))));
    if (!ix) {
      log(`${repo.name}: no SCIP indexer for this language`);
      continue;
    }
    const found = await run(ix.cmd, ['--help'], {cwd: repo.dir, timeoutMs: 20_000}).catch(() => undefined);
    if (!found || /ENOENT|not found/i.test(found.stderr ?? '')) {
      log(`${repo.name}: ${ix.cmd} isn't installed, skipped`);
      continue;
    }
    log(`${repo.name}: ${ix.cmd} ${ix.args.join(' ')}…`);
    const r = await run(ix.cmd, ix.args, {cwd: repo.dir, timeoutMs: 30 * 60_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
    const f = indexFile(repo.dir);
    log(r.code === 0 && f ? `${repo.name}: indexed (${Math.round(statSync(f).size / 1024)} KB)` : `${repo.name}: ${ix.cmd} failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  }
}
