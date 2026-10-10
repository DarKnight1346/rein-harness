import {run} from '../util/proc.js';

/**
 * Sparse and partial checkouts: what's on disk of a repo too big to check out whole, so the agent
 * knows the rest exists (and how to look at it without checking it out), and /workspace sparse can widen it.
 */
export type Checkout = {sparse?: string[]; filter?: string};

const git = async (cwd: string, ...args: string[]) => (await run('git', args, {cwd, timeoutMs: 20_000}).catch(() => undefined)) ?? {code: 1, stdout: '', stderr: ''};

export async function checkoutState(dir: string): Promise<Checkout> {
  const out: Checkout = {};
  if ((await git(dir, 'config', '--bool', 'core.sparseCheckout')).stdout.trim() === 'true') {
    const list = await git(dir, 'sparse-checkout', 'list');
    if (list.code === 0) out.sparse = list.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  const filter = (await git(dir, 'config', '--get', 'remote.origin.partialclonefilter')).stdout.trim();
  if (filter) out.filter = filter;
  return out;
}

export const describeCheckout = (c: Checkout) =>
  [c.sparse && (c.sparse.length ? `sparse: ${c.sparse.join(', ')}` : 'sparse: top-level files only'), c.filter && `partial clone (${c.filter})`].filter(Boolean).join(' · ');

/** Check out more folders of a sparse repo. */
export async function sparseAdd(dir: string, folders: string[]): Promise<{ok: boolean; output: string}> {
  const r = await git(dir, 'sparse-checkout', 'add', ...folders);
  return {ok: r.code === 0, output: (r.stderr || r.stdout).trim()};
}

/** For the system prompt, when the launch repo is sparse: the rest is in git, not on disk. */
export function sparsePrompt(c: Checkout): string | undefined {
  if (!c.sparse) return undefined;
  return [
    '# Sparse checkout',
    `This repo is a sparse checkout: only ${c.sparse.length ? c.sparse.map((s) => `${s}/`).join(', ') : 'the top-level files'} ${c.sparse.length ? 'are' : 'is'} on disk (plus top-level files)${c.filter ? `, and it's a partial clone (${c.filter}): file contents are fetched on demand` : ''}.`,
    'Other folders exist in the repo but not on disk, so search and list don\'t see them. `git ls-tree -r --name-only HEAD <folder>` lists their files and `git show HEAD:<path>` reads one without checking it out. If you need to change files outside the checkout, ask the user to widen it (/workspace sparse, or git sparse-checkout add <folder>).',
  ].join('\n');
}
