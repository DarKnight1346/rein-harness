import {run} from '../util/proc.js';
import type {Workspace} from '../workspace/index.js';

/**
 * Linked PRs across a workspace (/workspace prs, /workspace link-prs): the pull requests for one
 * branch name in each repo, and a "Related pull requests" section in each description listing the
 * others, between markers so running it again updates instead of repeating.
 */
export type RepoPr = {repo: string; dir: string; number: number; url: string; title: string; state: string; body: string};

const START = '<!-- rein:linked-prs -->';
const END = '<!-- /rein:linked-prs -->';

export async function prsForBranch(ws: Workspace, branch: string): Promise<RepoPr[]> {
  const found = await Promise.all(
    ws.repos
      .filter((r) => r.present)
      .map(async (r) => {
        const res = await run('gh', ['pr', 'view', branch, '--json', 'number,url,title,state,body'], {cwd: r.path, timeoutMs: 60_000}).catch(() => undefined);
        if (res?.code !== 0) return undefined;
        try {
          return {repo: r.name, dir: r.path, ...(JSON.parse(res.stdout) as Omit<RepoPr, 'repo' | 'dir'>)};
        } catch {
          return undefined;
        }
      }),
  );
  return found.filter((p): p is RepoPr => !!p);
}

/** The description with its related-PRs section added, or replaced if it's already there. */
export function linkedBody(body: string, self: RepoPr, all: RepoPr[]): string {
  const others = all.filter((p) => p.url !== self.url);
  const section = [START, '### Related pull requests', '', ...others.map((p) => `- ${p.repo}: ${p.url} (${p.title})`), '', '_Merge together: these change the same feature across repos._', END].join('\n');
  const i = body.indexOf(START);
  const j = body.indexOf(END);
  if (i >= 0 && j > i) return `${body.slice(0, i)}${section}${body.slice(j + END.length)}`;
  return `${body.trimEnd()}${body.trim() ? '\n\n' : ''}${section}\n`;
}

export async function linkPrs(prs: RepoPr[]): Promise<{updated: string[]; failed: string[]}> {
  const updated: string[] = [];
  const failed: string[] = [];
  for (const p of prs) {
    const res = await run('gh', ['pr', 'edit', String(p.number), '--body', linkedBody(p.body ?? '', p, prs)], {cwd: p.dir, timeoutMs: 60_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
    if (res.code === 0) updated.push(`${p.repo}#${p.number}`);
    else failed.push(`${p.repo}#${p.number}: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);
  }
  return {updated, failed};
}
