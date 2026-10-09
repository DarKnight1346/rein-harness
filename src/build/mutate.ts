import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.js';

/**
 * Mutation testing of what you changed (/mutate): small bugs are planted in the changed files and the
 * tests run against each; a mutant the tests don't catch ("survived") shows a gap. Stryker's JSON
 * report is read in full; mutmut and go-mutesting are run and their own summary is shown.
 */
export type Mutator = {tool: 'stryker' | 'mutmut' | 'go-mutesting'; bin: string};
export type Survivor = {file: string; line: number; mutator: string; replacement?: string};

export async function detectMutator(root: string, files: string[]): Promise<Mutator | undefined> {
  const has = async (bin: string) => (await run(bin, ['--version'], {cwd: root, timeoutMs: 20_000}).catch(() => undefined))?.code === 0;
  const stryker = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'stryker.cmd' : 'stryker');
  if (files.some((f) => /\.[cm]?[jt]sx?$/.test(f)) && existsSync(stryker)) return {tool: 'stryker', bin: stryker};
  if (files.some((f) => f.endsWith('.py')) && (await has('mutmut'))) return {tool: 'mutmut', bin: 'mutmut'};
  if (files.some((f) => f.endsWith('.go')) && (await has('go-mutesting'))) return {tool: 'go-mutesting', bin: 'go-mutesting'};
  return undefined;
}

/** Surviving mutants from Stryker's mutation-testing report (reports/mutation/mutation.json). */
export function strykerSurvivors(json: string, root: string): Survivor[] {
  const report = JSON.parse(json) as {files?: Record<string, {mutants?: {status: string; mutatorName: string; replacement?: string; location: {start: {line: number}}}[]}>};
  return Object.entries(report.files ?? {}).flatMap(([file, f]) =>
    (f.mutants ?? [])
      .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
      .map((m) => ({file: path.relative(root, path.resolve(root, file)).split(path.sep).join('/'), line: m.location.start.line, mutator: m.mutatorName, ...(m.replacement ? {replacement: m.replacement} : {})})),
  );
}

export type MutationResult = {tool: Mutator['tool']; survivors?: Survivor[]; summary?: string; error?: string};

export async function mutate(root: string, files: string[], m: Mutator): Promise<MutationResult> {
  const timeoutMs = 30 * 60_000;
  if (m.tool === 'stryker') {
    const src = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.(test|spec)\.|__tests__/.test(f));
    if (!src.length) return {tool: 'stryker', summary: 'Only test files changed: nothing to mutate.'};
    const r = await run(m.bin, ['run', '--mutate', src.join(','), '--reporters', 'json,clear-text'], {cwd: root, timeoutMs}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
    const report = path.join(root, 'reports', 'mutation', 'mutation.json');
    if (!existsSync(report)) return {tool: 'stryker', error: (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n') || 'Stryker produced no report'};
    return {tool: 'stryker', survivors: strykerSurvivors(readFileSync(report, 'utf8'), root)};
  }
  const args = m.tool === 'mutmut' ? ['run', `--paths-to-mutate=${files.filter((f) => f.endsWith('.py')).join(',')}`] : files.filter((f) => f.endsWith('.go'));
  const r = await run(m.bin, args, {cwd: root, timeoutMs}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
  let out = `${r.stdout}\n${r.stderr}`.trim();
  if (m.tool === 'mutmut') out = `${out}\n${(await run('mutmut', ['results'], {cwd: root, timeoutMs: 60_000}).catch(() => undefined))?.stdout ?? ''}`.trim();
  return {tool: m.tool, summary: out.split('\n').slice(-25).join('\n')};
}

export function formatMutation(r: MutationResult): string {
  if (r.error) return `${r.tool} failed: ${r.error}`;
  if (r.summary !== undefined) return `${r.tool}:\n${r.summary}`;
  const s = r.survivors ?? [];
  if (!s.length) return `${r.tool}: every mutant in the changed files was caught by the tests.`;
  return [`${r.tool}: ${s.length} mutant${s.length === 1 ? '' : 's'} survived (the tests still pass with these bugs planted):`, ...s.slice(0, 30).map((m) => `  ${m.file}:${m.line} ${m.mutator}${m.replacement ? ` → ${m.replacement}` : ''}`)].join('\n');
}
