import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {detectTestCommand} from '../agents/bestOf.js';
import {linkPrs, prsForBranch} from '../pr/linked.js';
import {run} from '../util/proc.js';
import {shellFor} from '../util/platform.js';
import type {Workspace} from '../workspace/index.js';
import type {Edge} from './services.js';

/**
 * Coordinated change sets (/changeset): one task across N repos of a workspace, as one branch name
 * in each, tested together (in dependency order: what's called before what calls it), and opened as
 * pull requests that link to each other. Saved in the workspace's .rein/changesets/<name>.json.
 */
export type ChangeSet = {name: string; branch: string; repos: string[]; createdAt: number};
export type RepoState = {repo: string; dir: string; onBranch: boolean; ahead: number; dirty: number};

const dir = (ws: Workspace) => path.join(ws.root, '.rein', 'changesets');
const file = (ws: Workspace, name: string) => path.join(dir(ws), `${name}.json`);
const git = async (cwd: string, ...a: string[]) => (await run('git', a, {cwd, timeoutMs: 60_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}))) as {code: number; stdout: string; stderr: string};

export function loadChangeSets(ws: Workspace): ChangeSet[] {
  try {
    return readdirSync(dir(ws)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(dir(ws), f), 'utf8')) as ChangeSet).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

const reposOf = (ws: Workspace, names?: string[]) => ws.repos.filter((r) => r.present && (!names?.length || names.includes(r.name)));

/** Start: the branch in each repo (from what's checked out there now, local changes carried along). */
export async function startChangeSet(ws: Workspace, name: string, repoNames?: string[]): Promise<{set: ChangeSet; done: string[]; failed: string[]}> {
  const branch = name.replace(/[^\w./-]+/g, '-');
  const repos = reposOf(ws, repoNames);
  const unknown = (repoNames ?? []).filter((n) => !ws.repos.some((r) => r.name === n && r.present));
  const done: string[] = [];
  const failed = unknown.map((n) => `${n}: not a cloned repo of this workspace`);
  for (const r of repos) {
    const exists = (await git(r.path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`)).code === 0;
    const res = await git(r.path, 'switch', ...(exists ? [branch] : ['-c', branch]));
    if (res.code === 0) done.push(r.name);
    else failed.push(`${r.name}: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);
  }
  const set: ChangeSet = {name, branch, repos: done, createdAt: Date.now()};
  mkdirSync(dir(ws), {recursive: true});
  writeFileSync(file(ws, name), JSON.stringify(set, null, 2) + '\n');
  return {set, done, failed};
}

export async function changeSetState(ws: Workspace, set: ChangeSet): Promise<RepoState[]> {
  return Promise.all(
    reposOf(ws, set.repos).map(async (r) => {
      const current = (await git(r.path, 'branch', '--show-current')).stdout.trim();
      const upstream = (await git(r.path, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')).stdout.trim().replace('refs/remotes/', '') || 'HEAD';
      const ahead = Number((await git(r.path, 'rev-list', '--count', `${upstream}..${set.branch}`)).stdout.trim()) || 0;
      const dirty = (await git(r.path, 'status', '--porcelain')).stdout.split('\n').filter(Boolean).length;
      return {repo: r.name, dir: r.path, onBranch: current === set.branch, ahead, dirty};
    }),
  );
}

/** Repos in dependency order: those that others call first (edges are caller → callee). */
export function dependencyOrder(repos: string[], edges: Edge[]): string[] {
  const deps = new Map(repos.map((r) => [r, new Set(edges.filter((e) => e.from === r && repos.includes(e.to)).map((e) => e.to))]));
  const out: string[] = [];
  const visit = (r: string, stack: Set<string>) => {
    if (out.includes(r) || stack.has(r)) return; // a cycle: keep the order we have
    stack.add(r);
    for (const d of deps.get(r) ?? []) visit(d, stack);
    stack.delete(r);
    out.push(r);
  };
  for (const r of repos) visit(r, new Set());
  return out;
}

export type TestResult = {repo: string; command?: string; ok: boolean; output: string};
export type TestRunner = (command: string, cwd: string) => Promise<{ok: boolean; output: string}>;
const shellRunner: TestRunner = async (command, cwd) => {
  const sh = shellFor(command);
  const r = await run(sh.file, sh.args, {cwd, timeoutMs: 60 * 60_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
  return {ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim()};
};

/** Build and test every repo of the set on its branch, in dependency order. */
export async function testChangeSet(ws: Workspace, set: ChangeSet, edges: Edge[], runner: TestRunner = shellRunner, log: (l: string) => void = () => {}): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const name of dependencyOrder(set.repos, edges)) {
    const r = ws.repos.find((x) => x.name === name)!;
    const current = (await git(r.path, 'branch', '--show-current')).stdout.trim();
    if (current !== set.branch) {
      results.push({repo: name, ok: false, output: `on ${current || 'a detached HEAD'}, not ${set.branch}`});
      continue;
    }
    const command = detectTestCommand(r.path);
    if (!command) {
      results.push({repo: name, ok: true, output: 'no test command found (skipped)'});
      continue;
    }
    log(`${name}: ${command}…`);
    const t = await runner(command, r.path);
    results.push({repo: name, command, ok: t.ok, output: t.output.split('\n').slice(-12).join('\n')});
  }
  return results;
}

/** Push each repo's branch, open its PR (gh), then link the PRs to each other. */
export async function openPrs(ws: Workspace, set: ChangeSet, title: string, exec: typeof git = git): Promise<{opened: string[]; failed: string[]; linked: string[]}> {
  const opened: string[] = [];
  const failed: string[] = [];
  for (const r of reposOf(ws, set.repos)) {
    const push = await exec(r.path, 'push', '-u', 'origin', set.branch);
    if (push.code !== 0) {
      failed.push(`${r.name}: git push failed: ${(push.stderr || push.stdout).trim().split('\n').pop()}`);
      continue;
    }
    const pr = await run('gh', ['pr', 'create', '--head', set.branch, '--title', title, '--body', `Part of the change set "${set.name}" across ${set.repos.join(', ')}.`], {cwd: r.path, timeoutMs: 120_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
    if (pr.code === 0 || /already exists/.test(pr.stderr)) opened.push(r.name);
    else failed.push(`${r.name}: gh pr create failed: ${(pr.stderr || pr.stdout).trim().split('\n').pop()}`);
  }
  const prs = await prsForBranch(ws, set.branch);
  const linked = prs.length > 1 ? (await linkPrs(prs)).updated : [];
  return {opened, failed, linked};
}

export function formatState(set: ChangeSet, states: RepoState[]): string {
  return [`Change set ${set.name} (branch ${set.branch}):`, ...states.map((s) => `  ${s.onBranch ? '✓' : '!'} ${s.repo}  ${s.onBranch ? `${s.ahead} commit${s.ahead === 1 ? '' : 's'}` : `not on ${set.branch}`}${s.dirty ? `, ${s.dirty} uncommitted` : ''}`)].join('\n');
}

export function formatTests(results: TestResult[]): string {
  const failed = results.filter((r) => !r.ok);
  return [failed.length ? `${failed.length} of ${results.length} repos failed:` : `All ${results.length} repos pass, tested in dependency order:`, ...results.map((r) => `  ${r.ok ? '✓' : '✗'} ${r.repo}${r.command ? `  ${r.command}` : ''}${r.ok ? '' : `\n${r.output.split('\n').map((l) => `      ${l}`).join('\n')}`}`)].join('\n');
}
