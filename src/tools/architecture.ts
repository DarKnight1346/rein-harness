import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {globToRegExp} from './fs.js';

/**
 * Architecture guardrails (.rein/architecture.yaml): which parts of the code may import which.
 * Checked on every write and edit, for the imports the change adds (an old violation doesn't block
 * unrelated edits), and across the repo by /arch. JS/TS, Python and Go imports are resolved to
 * project files; other languages aren't checked. Without the file nothing runs.
 */
export type ArchRule = {from: string[]; deny: string[]; allow?: string[]; packages: string[]; reason?: string};
export type Architecture = {mode: 'block' | 'warn'; layers: Record<string, string[]>; rules: ArchRule[]; errors: string[]};
export type Violation = {file: string; import: string; target: string; rule: ArchRule};

export const ARCH_FILE = path.join('.rein', 'architecture.yaml');
const toPosix = (p: string) => p.split(path.sep).join('/');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

export function loadArchitecture(root: string): Architecture | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(root, ARCH_FILE), 'utf8');
  } catch {
    return undefined;
  }
  const arch: Architecture = {mode: 'block', layers: {}, rules: [], errors: []};
  let doc: Record<string, unknown>;
  try {
    doc = (parse(text) ?? {}) as Record<string, unknown>;
  } catch (err) {
    arch.errors.push(`${ARCH_FILE}: ${(err as Error).message.split('\n')[0]}`);
    return arch;
  }
  if (doc.mode === 'warn') arch.mode = 'warn';
  for (const [name, globs] of Object.entries((doc.layers ?? {}) as Record<string, unknown>)) arch.layers[name] = list(globs);
  for (const [i, raw] of (Array.isArray(doc.rules) ? doc.rules : []).entries()) {
    const r = raw as Record<string, unknown>;
    const from = list(r.from);
    if (!from.length) {
      arch.errors.push(`rules[${i}]: needs from`);
      continue;
    }
    const unknown = [...from, ...list(r.deny), ...list(r.allow)].filter((x) => !arch.layers[x] && !/[*/.]/.test(x));
    if (unknown.length) arch.errors.push(`rules[${i}]: unknown layer ${unknown.join(', ')} (a layer name, or a glob like "src/ui/**")`);
    arch.rules.push({from, deny: list(r.deny), ...(r.allow !== undefined ? {allow: list(r.allow)} : {}), packages: list(r.packages), ...(typeof r.reason === 'string' ? {reason: r.reason} : {})});
  }
  return arch;
}

/** A layer name or glob as tests on project-relative paths. */
function matcher(arch: Architecture, refs: string[]): (rel: string) => boolean {
  const res = refs.flatMap((r) => arch.layers[r] ?? [r]).map((g) => {
    const glob = g.replace(/^\.?\//, '').replace(/\/$/, '/**');
    const re = globToRegExp(glob);
    const inside = globToRegExp(`${glob.replace(/\/\*\*$/, '')}/**`);
    return (p: string) => re.test(p) || inside.test(p);
  });
  return (rel) => res.some((t) => t(rel));
}

const JS = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
/** The import specifiers in a source file. */
export function importsOf(file: string, text: string): string[] {
  const out: string[] = [];
  const add = (re: RegExp, g = 1) => {
    for (const m of text.matchAll(re)) if (m[g]) out.push(m[g]);
  };
  if (JS.test(file)) {
    add(/(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g);
    add(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/g);
    add(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  } else if (file.endsWith('.py')) {
    add(/^\s*from\s+(\.*[\w.]*)\s+import\s/gm);
    for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) out.push(...m[1]!.split(/\s*,\s*/));
  } else if (file.endsWith('.go')) {
    add(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm);
    for (const block of text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) for (const m of block[1]!.matchAll(/(?:^|\n)\s*(?:[\w.]+\s+)?"([^"]+)"/g)) out.push(m[1]!);
  }
  return [...new Set(out)];
}

const goModule = (root: string) => {
  try {
    return readFileSync(path.join(root, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)?.[1];
  } catch {
    return undefined;
  }
};

/** Where an import points: a project-relative path, or {pkg} for a package outside the project. */
export function resolveImport(root: string, file: string, spec: string): {path: string} | {pkg: string} {
  const dir = path.dirname(path.join(root, file));
  const rel = (abs: string) => toPosix(path.relative(root, abs));
  if (JS.test(file)) {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return {pkg: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!};
    const base = path.resolve(dir, spec);
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, ''); // TS sources import "./x.js"
    for (const c of [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'].map((e) => stem + e), ...['ts', 'tsx', 'js'].map((e) => path.join(base, `index.${e}`))]) if (existsSync(c)) return {path: rel(c)};
    return {path: rel(base)};
  }
  if (file.endsWith('.py')) {
    const dots = spec.match(/^\.*/)![0].length;
    const mod = spec.slice(dots).replace(/\./g, '/');
    const base = dots ? path.resolve(dir, ...Array(dots - 1).fill('..'), mod) : path.join(root, mod);
    for (const c of [`${base}.py`, path.join(base, '__init__.py')]) if (existsSync(c)) return {path: rel(c)};
    return dots ? {path: rel(base)} : {pkg: spec.split('.')[0]!};
  }
  if (file.endsWith('.go')) {
    const mod = goModule(root);
    if (mod && (spec === mod || spec.startsWith(`${mod}/`))) return {path: spec.slice(mod.length + 1) || '.'};
    return {pkg: spec};
  }
  return {pkg: spec};
}

/** The rule an import breaks, if any. */
function broken(arch: Architecture, rel: string, target: {path: string} | {pkg: string}): ArchRule | undefined {
  for (const rule of arch.rules) {
    if (!matcher(arch, rule.from)(rel)) continue;
    if ('pkg' in target) {
      if (rule.packages.some((p) => p === target.pkg || globToRegExp(p).test(target.pkg))) return rule;
      continue;
    }
    if (target.path === rel) continue;
    if (rule.deny.length && matcher(arch, rule.deny)(target.path)) return rule;
    // allow: only these (and the rule's own layer) — project files only; packages go through `packages`.
    if (rule.allow && !matcher(arch, [...rule.allow, ...rule.from])(target.path)) return rule;
  }
  return undefined;
}

/** Violations in a file's imports; with `before`, only imports the change adds. */
export function checkImports(root: string, arch: Architecture, file: string, after: string, before = ''): Violation[] {
  const rel = toPosix(path.isAbsolute(file) ? path.relative(root, file) : file);
  const had = new Set(importsOf(rel, before));
  const out: Violation[] = [];
  for (const spec of importsOf(rel, after)) {
    if (had.has(spec)) continue;
    const target = resolveImport(root, rel, spec);
    const rule = broken(arch, rel, target);
    if (rule) out.push({file: rel, import: spec, target: 'pkg' in target ? target.pkg : target.path, rule});
  }
  return out;
}

export function violationMessage(v: Violation[], blocked: boolean): string {
  const lines = v.map((x) => `- ${x.file} imports ${x.import}${x.import !== x.target ? ` (${x.target})` : ''}${x.rule.reason ? `: ${x.rule.reason}` : `, which the rule for ${x.rule.from.join(', ')} doesn't allow`}`);
  return `${blocked ? 'Refused: this change breaks' : 'Note: this change breaks'} the architecture rules in ${ARCH_FILE}:\n${lines.join('\n')}\n${blocked ? 'Find a way that keeps to them (go through the layer that is allowed), or ask the user to change the rule.' : 'Consider keeping to them, or tell the user why not.'}`;
}

/** /arch: every violation in the project's files as they are now (at most `max`). */
export async function checkProject(root: string, arch: Architecture, max = 200): Promise<{violations: Violation[]; files: number}> {
  const {ripgrep} = await import('./fs.js');
  const {run} = await import('../util/proc.js');
  const rg = await ripgrep();
  const listed = rg ? ((await run(rg, ['--files', '--color', 'never'], {cwd: root, timeoutMs: 30_000}).catch(() => undefined))?.stdout ?? '') : '';
  const files = listed.split(/\r?\n/).map((f) => f.replace(/\\/g, '/')).filter((f) => f && (JS.test(f) || f.endsWith('.py') || f.endsWith('.go')));
  const violations: Violation[] = [];
  for (const f of files) {
    if (violations.length >= max) break;
    let text = '';
    try {
      text = readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    violations.push(...checkImports(root, arch, f, text));
  }
  return {violations: violations.slice(0, max), files: files.length};
}
