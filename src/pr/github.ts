import {existsSync} from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.js';

/**
 * Pull request helpers for /pr, through the GitHub CLI (gh) and, for merge queues, Mergify, Graphite
 * and GitLab's CLI (glab). Everything that changes a PR is run only when the user asks for it.
 */
export type Pr = {number: number; url: string; title: string; state: string; isDraft: boolean; additions: number; deletions: number; changedFiles: number; headRefName: string; baseRefName: string; reviewDecision?: string; mergeStateStatus?: string};

const gh = (root: string, args: string[], timeoutMs = 60_000) => run('gh', args, {cwd: root, timeoutMs}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
const lastLine = (s: string) => s.trim().split('\n').pop() ?? '';
const ghError = (msg: string) => (/ENOENT|not found: gh|command not found/i.test(msg) ? "the GitHub CLI (gh) isn't installed" : msg);

export async function currentPr(root: string): Promise<Pr | {error: string}> {
  const r = await gh(root, ['pr', 'view', '--json', 'number,url,title,state,isDraft,additions,deletions,changedFiles,headRefName,baseRefName,reviewDecision,mergeStateStatus']);
  if (r.code !== 0) return {error: ghError(lastLine(r.stderr || r.stdout) || 'no pull request for this branch')};
  try {
    return JSON.parse(r.stdout) as Pr;
  } catch {
    return {error: 'unexpected output from gh pr view'};
  }
}

export function describePr(p: Pr): string {
  return [
    `#${p.number} ${p.title}${p.isDraft ? ' (draft)' : ''} · ${p.state.toLowerCase()} · ${p.headRefName} → ${p.baseRefName}`,
    `  +${p.additions} −${p.deletions} in ${p.changedFiles} file${p.changedFiles === 1 ? '' : 's'}${p.reviewDecision ? ` · review: ${p.reviewDecision.toLowerCase().replace(/_/g, ' ')}` : ''}${p.mergeStateStatus ? ` · merge: ${p.mergeStateStatus.toLowerCase()}` : ''}`,
    `  ${p.url}`,
  ].join('\n');
}

/** The branch's size against its base (merge-base with origin/<default>): lines added + removed. */
export async function branchSize(root: string): Promise<{lines: number; added: number; removed: number; base: string} | undefined> {
  const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 20_000}).catch(() => undefined))?.stdout.trim() ?? '';
  const head = (await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')).replace('refs/remotes/', '') || 'origin/main';
  const base = await git('merge-base', 'HEAD', head);
  if (!base) return undefined;
  const stat = await git('diff', '--shortstat', base);
  const added = Number(stat.match(/(\d+) insertion/)?.[1] ?? 0);
  const removed = Number(stat.match(/(\d+) deletion/)?.[1] ?? 0);
  return {lines: added + removed, added, removed, base: head};
}

export type ReviewComment = {author: string; body: string; path?: string; line?: number; url?: string};

/** Review comments on the PR: inline ones (with file and line) and the reviews' own text. */
export async function reviewComments(root: string, p: Pr): Promise<ReviewComment[] | {error: string}> {
  const repo = await gh(root, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (repo.code !== 0) return {error: ghError(lastLine(repo.stderr))};
  const inline = await gh(root, ['api', '--paginate', `repos/${repo.stdout.trim()}/pulls/${p.number}/comments`]);
  const reviews = await gh(root, ['pr', 'view', String(p.number), '--json', 'reviews', '-q', '.reviews']);
  const out: ReviewComment[] = [];
  try {
    for (const c of JSON.parse(inline.stdout || '[]') as {user?: {login?: string}; body: string; path?: string; line?: number; original_line?: number; html_url?: string}[])
      out.push({author: c.user?.login ?? '?', body: c.body, path: c.path, line: c.line ?? c.original_line, url: c.html_url});
    for (const r of JSON.parse(reviews.stdout || '[]') as {author?: {login?: string}; body: string; state: string}[]) if (r.body?.trim()) out.push({author: r.author?.login ?? '?', body: `[${r.state.toLowerCase()}] ${r.body}`});
  } catch {
    return {error: 'unexpected output from gh'};
  }
  return out;
}

export type Queue = {via: 'mergify' | 'graphite' | 'github' | 'gitlab'; command: string[]; describe: string};

/** How to put the PR in its merge queue: Mergify, Graphite, GitLab's auto-merge, or GitHub's auto-merge (its merge queue when the base has one). */
export async function queueFor(root: string, p: Pr | undefined): Promise<Queue> {
  if (existsSync(path.join(root, '.mergify.yml')) || existsSync(path.join(root, '.mergify', 'config.yml')))
    return {via: 'mergify', command: ['gh', 'pr', 'comment', String(p?.number ?? ''), '--body', '@Mergifyio queue'], describe: 'comment "@Mergifyio queue" on the PR (Mergify)'};
  if ((await run('gt', ['--version'], {cwd: root, timeoutMs: 10_000}).catch(() => undefined))?.code === 0 && existsSync(path.join(root, '.git', '.graphite_repo_config')))
    return {via: 'graphite', command: ['gt', 'merge'], describe: 'gt merge (Graphite merges the stack)'};
  if ((await run('git', ['remote', 'get-url', 'origin'], {cwd: root, timeoutMs: 10_000}).catch(() => undefined))?.stdout.includes('gitlab'))
    return {via: 'gitlab', command: ['glab', 'mr', 'merge', '--auto-merge', '--yes'], describe: 'glab mr merge --auto-merge (merge when the pipeline succeeds)'};
  return {via: 'github', command: ['gh', 'pr', 'merge', String(p?.number ?? ''), '--auto', '--squash'], describe: 'gh pr merge --auto --squash (GitHub auto-merge; the merge queue when the base branch has one)'};
}

export async function runQueue(root: string, q: Queue): Promise<{ok: boolean; output: string}> {
  const r = await run(q.command[0]!, q.command.slice(1), {cwd: root, timeoutMs: 120_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
  return {ok: r.code === 0, output: (r.stdout || r.stderr).trim()};
}
