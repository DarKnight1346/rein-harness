import {run} from './proc.js';

/** The working tree's changed and new files, vs HEAD (relative to `root`). */
export async function changedFiles(root: string): Promise<string[]> {
  const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 20_000}).catch(() => undefined))?.stdout ?? '';
  const out = `${await git('diff', '--name-only', 'HEAD')}\n${await git('ls-files', '--others', '--exclude-standard')}`;
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
}
