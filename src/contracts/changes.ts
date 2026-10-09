import {readFileSync} from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.js';
import {contractKind, diffContract, formatChanges, type Change} from './diff.js';

/** Contract files changed on the branch (against its base) or in a request, classified. */
export type FileChanges = {file: string; changes: Change[]};

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};

/** One contract file, from its old text to its new one; undefined if it isn't a contract. */
export function classify(file: string, before: string | undefined, after: string | undefined): FileChanges | undefined {
  const kind = contractKind(file, after ?? before);
  if (!kind) return undefined;
  if (before === undefined) return {file, changes: [{kind: 'safe', where: file, what: 'new contract'}]};
  if (after === undefined) return {file, changes: [{kind: 'breaking', where: file, what: 'contract file deleted'}]};
  return {file, changes: diffContract(kind, before, after)};
}

/** /contracts: every contract file the branch changes against its base (merge-base with origin's default branch, else HEAD). */
export async function branchContracts(root: string): Promise<{base: string; files: FileChanges[]}> {
  const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 30_000}).catch(() => undefined)) ?? {code: 1, stdout: '', stderr: ''};
  const head = (await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')).stdout.trim().replace('refs/remotes/', '') || 'origin/main';
  const mb = (await git('merge-base', 'HEAD', head)).stdout.trim();
  const base = mb || 'HEAD';
  const changed = (await git('diff', '--name-only', '--no-renames', base)).stdout.split('\n').filter(Boolean);
  const added = (await git('ls-files', '--others', '--exclude-standard')).stdout.split('\n').filter(Boolean);
  const files: FileChanges[] = [];
  for (const f of [...new Set([...changed, ...added])]) {
    const old = await git('show', `${base}:${f}`);
    const r = classify(f, old.code === 0 ? old.stdout : undefined, read(path.join(root, f)));
    if (r) files.push(r);
  }
  return {base: mb ? head : 'HEAD', files};
}

/** contract-check: the breaking changes a request made to contracts, as a note for the agent. */
export function contractNote(files: FileChanges[]): string | undefined {
  const breaking = files.filter((f) => f.changes.some((c) => c.kind === 'breaking'));
  if (!breaking.length) return undefined;
  return [
    'Your change breaks API contracts (a client built against the old version can fail):',
    ...breaking.map((f) => formatChanges(f.file, f.changes.filter((c) => c.kind === 'breaking'))),
    'If that is intended, say so to the user and make it a versioned or expand/contract change; if not, make it backward compatible (add instead of change or remove, keep old fields, give new inputs defaults).',
  ].join('\n');
}
