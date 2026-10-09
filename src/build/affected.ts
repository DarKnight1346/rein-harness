import {existsSync} from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.js';

/**
 * Affected-target analysis for monorepos: which projects or targets a change touches, from the build
 * system's own dependency graph (Nx, Turborepo, Bazel, Pants), and the command that tests just those.
 * Nothing here runs the tests; it answers "what does this change affect?".
 */
export type BuildSystem = 'nx' | 'turbo' | 'bazel' | 'pants';
export type Affected = {system: BuildSystem; targets: string[]; test: string; note?: string};

/** The monorepo build system at `root`, and the command to run it, if it's installed. */
export function detectBuild(root: string): {system: BuildSystem; bin: string} | undefined {
  const has = (f: string) => existsSync(path.join(root, f));
  const local = (name: string) => {
    const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
    return existsSync(bin) ? bin : undefined;
  };
  if (has('nx.json')) return {system: 'nx', bin: local('nx') ?? 'nx'};
  if (has('turbo.json')) return {system: 'turbo', bin: local('turbo') ?? 'turbo'};
  if (has('MODULE.bazel') || has('WORKSPACE') || has('WORKSPACE.bazel')) return {system: 'bazel', bin: 'bazel'};
  if (has('pants.toml')) return {system: 'pants', bin: 'pants'};
  return undefined;
}

/** Files changed in the working tree (vs HEAD), plus untracked ones: what "this change" means. */
export async function changedFiles(root: string): Promise<string[]> {
  const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 20_000}).catch(() => undefined))?.stdout ?? '';
  const out = `${await git('diff', '--name-only', 'HEAD')}\n${await git('ls-files', '--others', '--exclude-standard')}`;
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('>') && !/^(?:NX|Loading|INFO|WARNING|Computing)\b/i.test(l));
const quote = (s: string) => (/^[\w./:@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export async function affected(root: string, files: string[]): Promise<Affected | undefined> {
  const b = detectBuild(root);
  if (!b || !files.length) return undefined;
  const exec = (args: string[]) => run(b.bin, args, {cwd: root, timeoutMs: 120_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
  if (b.system === 'nx') {
    const r = await exec(['show', 'projects', '--affected', `--files=${files.join(',')}`]);
    if (r.code !== 0) return {system: 'nx', targets: [], test: '', note: (r.stderr || r.stdout).trim().split('\n').pop()};
    const targets = lines(r.stdout);
    return {system: 'nx', targets, test: targets.length ? `nx run-many -t test -p ${targets.join(',')}` : ''};
  }
  if (b.system === 'turbo') {
    // Turborepo compares with the base branch and includes uncommitted changes.
    const r = await exec(['ls', '--affected', '--output=json']);
    if (r.code !== 0) return {system: 'turbo', targets: [], test: '', note: (r.stderr || r.stdout).trim().split('\n').pop()};
    let targets: string[] = [];
    try {
      const j = JSON.parse(r.stdout);
      targets = (j.packages?.items ?? j.packages ?? []).map((p: {name?: string} | string) => (typeof p === 'string' ? p : p.name ?? '')).filter(Boolean);
    } catch {
      targets = lines(r.stdout);
    }
    return {system: 'turbo', targets, test: targets.length ? 'turbo run test --affected' : ''};
  }
  if (b.system === 'bazel') {
    const set = files.map(quote).join(' ');
    const r = await exec(['query', `rdeps(//..., set(${set}))`, '--output=label', '--keep_going']);
    const targets = lines(r.stdout).filter((l) => l.startsWith('//') || l.startsWith('@'));
    if (!targets.length && r.code !== 0) return {system: 'bazel', targets: [], test: '', note: (r.stderr || r.stdout).trim().split('\n').pop()};
    return {system: 'bazel', targets, test: targets.length ? `bazel test $(bazel query 'kind(".*_test", rdeps(//..., set(${set})))')` : ''};
  }
  const r = await exec(['--changed-since=HEAD', '--changed-dependents=transitive', 'list']);
  if (r.code !== 0) return {system: 'pants', targets: [], test: '', note: (r.stderr || r.stdout).trim().split('\n').pop()};
  const targets = lines(r.stdout);
  return {system: 'pants', targets, test: targets.length ? 'pants --changed-since=HEAD --changed-dependents=transitive test' : ''};
}

export function formatAffected(a: Affected): string {
  if (a.note && !a.targets.length) return `${a.system} couldn't say what this change affects: ${a.note}`;
  if (!a.targets.length) return `${a.system}: nothing depends on these changes.`;
  const shown = a.targets.slice(0, 40);
  return [
    `${a.system}: ${a.targets.length} affected ${a.system === 'bazel' || a.system === 'pants' ? 'target' : 'project'}${a.targets.length === 1 ? '' : 's'}${a.targets.length > shown.length ? ` (first ${shown.length})` : ''}:`,
    ...shown.map((t) => `  ${t}`),
    ...(a.test ? [`Test just these: ${a.test}`] : []),
  ].join('\n');
}
