import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {detectTestCommand} from '../agents/bestOf.js';
import {formatUsd} from '../providers/prices.js';
import {run} from '../util/proc.js';
import {shellFor} from '../util/platform.js';

/**
 * Benchmarks on your own repo (`rein bench`): real commits become tasks — the commit message is the
 * prompt, the code before it is the starting point, and the tests the commit added or changed are
 * the hidden check. Each model (or setting) runs every task headless in a fresh copy of the code
 * (exported with git archive, so the answer isn't in its history); then the commit's test files are
 * put in and the test command decides. Results: pass rate, time and cost per model.
 */
export type BenchTask = {id: string; commit: string; parent: string; prompt: string; tests: string[]; files: string[]; lines: number};
export type BenchResult = {task: string; model: string; passed: boolean; ms: number; usd?: number; error?: string};

export const benchDir = (root: string) => path.join(root, '.rein', 'bench');
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[a-z]+$|_test\.go$|(?:^|\/)test_[^/]+\.py$/i;

const git = async (root: string, ...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 60_000}).catch(() => undefined))?.stdout ?? '';

/** `rein bench init`: recent non-merge commits that change code and its tests, up to `max` lines. */
export async function pickTasks(root: string, count = 10, maxLines = 400): Promise<BenchTask[]> {
  const log = await git(root, 'log', '--no-merges', '--format=%H%x00%P%x00%B%x01', '-n', String(count * 15));
  const tasks: BenchTask[] = [];
  for (const entry of log.split('\x01')) {
    if (tasks.length >= count) break;
    const [commit, parents, body] = entry.trim().split('\0');
    if (!commit || !parents || parents.includes(' ') || !body?.trim()) continue;
    const stat = await git(root, 'show', '--numstat', '--format=', commit);
    const files = stat.split('\n').filter(Boolean).map((l) => l.split('\t')) .filter((p) => p.length === 3);
    const lines = files.reduce((n, [a, d]) => n + (Number(a) || 0) + (Number(d) || 0), 0);
    const paths = files.map((p) => p[2]!);
    const tests = paths.filter((f) => TEST_FILE.test(f));
    const code = paths.filter((f) => !TEST_FILE.test(f) && !/\.(?:md|txt|lock)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f));
    if (!tests.length || !code.length || lines > maxLines) continue;
    tasks.push({id: commit.slice(0, 8), commit, parent: parents.trim(), prompt: body.trim(), tests, files: code, lines});
  }
  return tasks;
}

export function saveTasks(root: string, tasks: BenchTask[]): string {
  mkdirSync(benchDir(root), {recursive: true});
  const f = path.join(benchDir(root), 'tasks.json');
  writeFileSync(f, JSON.stringify(tasks, null, 2) + '\n');
  return f;
}

export function loadTasks(root: string): BenchTask[] {
  try {
    return JSON.parse(readFileSync(path.join(benchDir(root), 'tasks.json'), 'utf8'));
  } catch {
    return [];
  }
}

/** A clean copy of the code at `rev` (no history), as its own one-commit repo so the run can diff. */
async function checkoutCopy(root: string, rev: string): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-bench-'));
  const tar = path.join(dir, '..', `${path.basename(dir)}.tar`);
  await run('git', ['archive', '--format=tar', '-o', tar, rev], {cwd: root, timeoutMs: 120_000});
  await run('tar', ['-xf', tar, '-C', dir], {timeoutMs: 120_000});
  rmSync(tar, {force: true});
  for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=rein', '-c', 'user.email=bench@rein', 'commit', '-qm', 'start']]) await run('git', a, {cwd: dir, timeoutMs: 60_000});
  return dir;
}

export type Agent = (prompt: string, model: string, cwd: string) => Promise<{ok: boolean; usd?: number; error?: string}>;
export type Tester = (command: string, cwd: string) => Promise<boolean>;

/** The agent: `rein -p` in the copy, bypass mode (nobody is there to approve), JSON out for the cost. */
const reinAgent: Agent = (prompt, model, cwd) =>
  new Promise((resolve) => {
    let out = '';
    const p = spawn(process.execPath, [process.argv[1]!, '-p', prompt, '--model', model, '--permission-mode', 'bypass', '--output-format', 'json'], {cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true});
    p.stdout.on('data', (d) => (out += d));
    p.on('error', (err) => resolve({ok: false, error: err.message}));
    p.on('close', (code) => {
      try {
        const r = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {is_error?: boolean; error?: string; cost_usd?: number};
        resolve({ok: code === 0 && !r.is_error, ...(r.cost_usd !== undefined ? {usd: r.cost_usd} : {}), ...(r.error ? {error: r.error} : {})});
      } catch {
        resolve({ok: false, error: `exit ${code}`});
      }
    });
  });

const shellTester: Tester = async (command, cwd) => {
  const sh = shellFor(command);
  return ((await run(sh.file, sh.args, {cwd, timeoutMs: 30 * 60_000}).catch(() => ({code: 1})))?.code ?? 1) === 0;
};

export async function runBench(
  root: string,
  tasks: BenchTask[],
  models: string[],
  opts: {test?: string; agent?: Agent; tester?: Tester; log?: (line: string) => void} = {},
): Promise<BenchResult[]> {
  const agent = opts.agent ?? reinAgent;
  const tester = opts.tester ?? shellTester;
  const results: BenchResult[] = [];
  for (const task of tasks) {
    for (const model of models) {
      const dir = await checkoutCopy(root, task.parent);
      const started = Date.now();
      try {
        const test = opts.test ?? detectTestCommand(dir);
        if (!test) {
          results.push({task: task.id, model, passed: false, ms: 0, error: 'no test command'});
          continue;
        }
        const a = await agent(`${task.prompt}\n\n(Make this change in the code here. When you're done, the project's tests should pass.)`, model, dir);
        // The hidden check: the commit's own test files, as they were after it.
        for (const f of task.tests) {
          const content = await run('git', ['show', `${task.commit}:${f}`], {cwd: root, timeoutMs: 30_000}).catch(() => undefined);
          if (content?.code !== 0) continue;
          mkdirSync(path.dirname(path.join(dir, f)), {recursive: true});
          writeFileSync(path.join(dir, f), content.stdout);
        }
        const passed = await tester(test, dir);
        const r: BenchResult = {task: task.id, model, passed, ms: Date.now() - started, ...(a.usd !== undefined ? {usd: a.usd} : {}), ...(a.error ? {error: a.error} : {})};
        results.push(r);
        opts.log?.(`${task.id} ${model}: ${passed ? 'passed' : 'failed'} (${Math.round(r.ms / 1000)}s${r.usd !== undefined ? `, ${formatUsd(r.usd)}` : ''})`);
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    }
  }
  return results;
}

export function saveResults(root: string, results: BenchResult[]): string {
  const dir = path.join(benchDir(root), 'results');
  mkdirSync(dir, {recursive: true});
  const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(f, JSON.stringify(results, null, 2) + '\n');
  return f;
}

export function formatBench(results: BenchResult[]): string {
  const models = [...new Set(results.map((r) => r.model))];
  const rows = models.map((m) => {
    const rs = results.filter((r) => r.model === m);
    const passed = rs.filter((r) => r.passed).length;
    const usd = rs.filter((r) => r.usd !== undefined);
    const ms = rs.reduce((n, r) => n + r.ms, 0) / (rs.length || 1);
    return `  ${m.padEnd(28)} ${String(passed).padStart(3)}/${rs.length} passed (${Math.round((passed / (rs.length || 1)) * 100)}%) · ${Math.round(ms / 1000)}s a task${usd.length ? ` · ${formatUsd(usd.reduce((n, r) => n + r.usd!, 0) / usd.length)} a task` : ''}`;
  });
  const tasks = [...new Set(results.map((r) => r.task))];
  return [`${tasks.length} task${tasks.length === 1 ? '' : 's'} from this repo's history:`, ...rows].join('\n');
}

export const hasBench = (root: string) => existsSync(path.join(benchDir(root), 'tasks.json'));
