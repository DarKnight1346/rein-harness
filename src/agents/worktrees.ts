import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {constants as fsConstants} from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {reinHome} from '../store/paths.js';

const run = promisify(execFile);

/**
 * Invisible git worktrees for subagents that would otherwise edit the same files at the same time.
 *
 * Nobody asks for one: a subagent gets a worktree on its first change, only when other work is
 * going on (it runs in the background, or another subagent is running). The worktree starts from
 * the project exactly as it is now, uncommitted and untracked files included (a snapshot commit
 * made with a temporary index; the user's index and branches are never touched). Dependency
 * folders (node_modules, .venv…) are linked, and small ignored files (.env…) copied, so builds and
 * tests work there as they do in the project. The subagent's paths are rewritten, so it never
 * notices.
 *
 * When the subagent finishes, its changes are merged back into the project file by file (a
 * three-way merge against the snapshot, so the main agent's edits since then are kept) and the
 * worktree is deleted. Only a real conflict (both changed the same lines) is left for the main
 * agent, with the subagent's version kept for it to merge.
 */
export type Worktree = {
  /** Root the subagent works in (the worktree, plus the project's sub-path inside the repo). */
  root: string;
  /** The worktree's top folder. */
  dir: string;
  /** Snapshot commit it started from. */
  base: string;
  /** Paths (repo-relative) linked into the worktree; never merged back. */
  linked: Set<string>;
  /** Git's own folders the worktree writes to (its admin folder, the shared objects): for the sandbox. */
  writable: string[];
  /** A visible branch (issue work): committed and kept when the agent finishes, never merged into the project. */
  branch?: string;
};

/**
 * `commits`: commits the subagent made in its worktree ("abc1234 subject"); they aren't on the
 * user's branch (their changes come back uncommitted), so `ref` keeps them reachable.
 */
export type MergeResult = {merged: string[]; conflicts: string[]; kept?: string; commits?: string[]; ref?: string; branch?: string};

/** Folders shared with the project by a symlink (dependencies: big, and only read by most work). */
const DEP_DIRS = new Set(['node_modules', '.venv', 'venv', '.tox', 'vendor', 'Pods', '.bundle', 'bower_components', 'jspm_packages', '.pnpm-store', '.yarn']);
/** Untracked files bigger than this are linked, not copied into the snapshot (disk images, datasets). */
const BIG_FILE = 20 * 1024 * 1024;
/** Small ignored files (.env, local config) are copied so the worktree runs like the project. */
const SMALL_IGNORED = 1024 * 1024;
/**
 * Other ignored folders (build output: dist/, target/, .next/…) are copied too, so tests that need a
 * built project work, as copy-on-write clones where the filesystem can (APFS, btrfs: instant, no
 * extra space). Up to this much in all; past it the subagent rebuilds what it needs.
 */
const IGNORED_DIRS_BUDGET = {files: 20_000, bytes: 500 * 1024 * 1024};

/** Files and bytes under a folder, or undefined once it's over the budget left. */
async function measure(dir: string, budget: {files: number; bytes: number}): Promise<{files: number; bytes: number} | undefined> {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(d, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files++;
        bytes += (await fsp.lstat(p).catch(() => undefined))?.size ?? 0;
        if (files > budget.files || bytes > budget.bytes) return undefined;
      }
    }
  }
  return {files, bytes};
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const {stdout} = await run('git', args, {cwd, env: {...process.env, ...env, GIT_TERMINAL_PROMPT: '0'}, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8'});
  return stdout;
}
async function gitBuf(cwd: string, args: string[]): Promise<Buffer | undefined> {
  try {
    const {stdout} = await run('git', args, {cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer'});
    return stdout;
  } catch {
    return undefined;
  }
}

/** The repo's top folder, or undefined outside git. */
export async function repoTop(dir: string): Promise<string | undefined> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A commit of the working tree exactly as it is (tracked changes and untracked, non-ignored files
 * under BIG_FILE), made with a temporary copy of the index: nothing the user sees changes.
 */
export async function snapshot(top: string, skip: ReadonlySet<string> = new Set()): Promise<{commit: string; big: string[]}> {
  const indexPath = path.resolve(top, (await git(top, ['rev-parse', '--git-path', 'index'])).trim());
  // In a private folder (mkdtemp, 0700): the index lists the project's files.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'rein-index-'));
  const tmp = path.join(tmpDir, 'index');
  if (existsSync(indexPath)) {
    copyFileSync(indexPath, tmp, fsConstants.COPYFILE_EXCL);
    // Keep the index's own timestamp: git trusts cached file stats only when they're older than the
    // index ("racy git"), and a fresh copy would make a same-size edit from that second look unchanged.
    const st = statSync(indexPath);
    utimesSync(tmp, st.atime, st.mtime);
  }
  const env = {GIT_INDEX_FILE: tmp};
  try {
    await git(top, ['add', '-u'], env);
    const untracked = (await git(top, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    const big: string[] = [];
    const add: string[] = [];
    for (const f of untracked) {
      if (skip.has(f)) continue;
      try {
        const st = lstatSync(path.join(top, f));
        if (st.isFile() && st.size > BIG_FILE) big.push(f);
        else add.push(f);
      } catch {}
    }
    for (let i = 0; i < add.length; i += 500) await git(top, ['add', '--', ...add.slice(i, i + 500)], env);
    // Paths linked into a worktree must never be recorded as symlinks.
    const drop = [...skip].filter((f) => !untracked.includes(f));
    if (drop.length) await git(top, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...drop], env).catch(() => '');
    const tree = (await git(top, ['write-tree'], env)).trim();
    const head = await git(top, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s.trim()).catch(() => '');
    const commit = (await git(top, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'rein: snapshot for a subagent worktree'], {GIT_AUTHOR_NAME: 'Rein', GIT_AUTHOR_EMAIL: 'rein@localhost', GIT_COMMITTER_NAME: 'Rein', GIT_COMMITTER_EMAIL: 'rein@localhost'})).trim();
    return {commit, big};
  } finally {
    rmSync(tmpDir, {recursive: true, force: true});
  }
}

/** Link dependency folders and big untracked files, copy small ignored files. Returns what was linked. */
async function furnish(top: string, dir: string, big: string[]): Promise<Set<string>> {
  const linked = new Set<string>();
  const link = (rel: string) => {
    const target = path.join(dir, rel);
    if (existsSync(target)) return;
    mkdirSync(path.dirname(target), {recursive: true});
    try {
      // A junction for a folder on Windows: directory symlinks there need admin rights or developer
      // mode (a file link may still fail without them; it's then left out).
      const source = path.join(top, rel);
      symlinkSync(source, target, lstatSync(source).isDirectory() ? 'junction' : 'file');
      linked.add(rel);
    } catch {}
  };
  for (const f of big) link(f);
  const ignored = (await git(top, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).catch(() => '')).split('\0').filter(Boolean);
  let copied = 0;
  const budget = {...IGNORED_DIRS_BUDGET};
  for (const entry of ignored) {
    const rel = entry.replace(/\/$/, '');
    if (entry.endsWith('/')) {
      if (DEP_DIRS.has(path.basename(rel))) link(rel);
      else {
        const size = await measure(path.join(top, rel), budget);
        if (!size) continue;
        try {
          await fsp.cp(path.join(top, rel), path.join(dir, rel), {recursive: true, mode: fsConstants.COPYFILE_FICLONE, verbatimSymlinks: true});
          budget.files -= size.files;
          budget.bytes -= size.bytes;
        } catch {}
      }
      continue;
    }
    if (copied >= 200) continue;
    try {
      const st = lstatSync(path.join(top, rel));
      if (!st.isFile() || st.size > SMALL_IGNORED) continue;
      mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true});
      copyFileSync(path.join(top, rel), path.join(dir, rel));
      copied++;
    } catch {}
  }
  return linked;
}

const same = (a: Buffer | undefined, b: Buffer | undefined) => (a === undefined ? b === undefined : b !== undefined && a.equals(b));

/** The repo-relative paths that differ between two commits, with git's status letter. */
async function changes(top: string, from: string, to: string): Promise<{status: string; path: string}[]> {
  const out = (await git(top, ['diff', '--name-status', '-z', '--no-renames', from, to])).split('\0').filter(Boolean);
  const list: {status: string; path: string}[] = [];
  for (let i = 0; i + 1 < out.length; i += 2) list.push({status: out[i]!, path: out[i + 1]!});
  return list;
}

/** File mode in a commit ('100755', '120000' for a symlink…), or undefined. */
async function modeIn(top: string, commit: string, rel: string): Promise<string | undefined> {
  const line = (await git(top, ['ls-tree', commit, '--', rel]).catch(() => '')).trim();
  return line ? line.split(/\s/)[0] : undefined;
}

/** A file's bytes, or a symlink's target, as it is now (no check-then-read: each call either works or throws). */
function readCurrent(file: string): {bytes: Buffer; link: boolean} | undefined {
  try {
    return {bytes: Buffer.from(readlinkSync(file)), link: true};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EINVAL' && (err as NodeJS.ErrnoException).code !== 'UNKNOWN') return undefined; // missing
  }
  try {
    return {bytes: readFileSync(file), link: false};
  } catch {
    return undefined; // a folder, or gone
  }
}

function writeFile(file: string, content: Buffer, mode: string | undefined): void {
  mkdirSync(path.dirname(file), {recursive: true});
  if (mode === '120000') {
    try {
      unlinkSync(file);
    } catch {}
    symlinkSync(content.toString(), file);
    return;
  }
  // Write beside it, then rename over it: atomic, and a symlink there is replaced, not written through.
  const tmp = `${file}.rein-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, content, {flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644});
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, {force: true});
    throw err;
  }
}

/** A working file as git would store it (its clean filters and line-ending rules applied). */
async function stored(top: string, rel: string, file: string, raw: Buffer): Promise<Buffer> {
  try {
    const id = (await git(top, ['hash-object', '-w', `--path=${rel}`, '--', file])).trim();
    return (await gitBuf(top, ['cat-file', 'blob', id])) ?? raw;
  } catch {
    return raw;
  }
}

/**
 * Stored content as it should be written into the project: in the existing file's line endings
 * when there is one (CRLF stays CRLF, LF stays LF), else as git would check it out.
 */
async function inUserStyle(top: string, commit: string, rel: string, content: Buffer, existing: Buffer | undefined): Promise<Buffer> {
  if (content.includes(0)) return content;
  if (existing !== undefined) {
    const crlf = existing.includes('\r\n');
    const text = content.toString('utf8');
    return Buffer.from(crlf ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n'), 'utf8');
  }
  // A new file: git's own checkout form (core.autocrlf, .gitattributes) for this path.
  return (await gitBuf(top, ['cat-file', '--filters', `${commit}:${rel}`])) ?? content;
}

/** Three-way merge of one text file; undefined = conflict (or not text). */
async function mergeText(ours: Buffer, base: Buffer, theirs: Buffer): Promise<Buffer | undefined> {
  if ([ours, base, theirs].some((b) => b.includes(0))) return undefined;
  // A private folder (mkdtemp, 0700): the file contents are the user's code.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-merge-'));
  try {
    const [o, b, t] = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
    writeFileSync(o!, ours, {mode: 0o600, flag: 'wx'});
    writeFileSync(b!, base, {mode: 0o600, flag: 'wx'});
    writeFileSync(t!, theirs, {mode: 0o600, flag: 'wx'});
    try {
      const {stdout} = await run('git', ['merge-file', '-p', o!, b!, t!], {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024});
      return stdout;
    } catch {
      return undefined; // exit > 0: conflicts
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

/** Apply the changes between two commits to a working tree (no index), merging with what's there. */
export async function mergeInto(top: string, base: string, result: string, linked: ReadonlySet<string> = new Set()): Promise<{merged: string[]; conflicts: string[]}> {
  const merged: string[] = [];
  const conflicts: string[] = [];
  for (const {status, path: rel} of await changes(top, base, result)) {
    if (linked.has(rel) || [...linked].some((l) => rel.startsWith(l + '/'))) continue;
    const file = path.join(top, rel);
    // Compared and merged as git stores them, so line-ending conversion (core.autocrlf, .gitattributes)
    // doesn't make an untouched file look changed; written back in the file's own line endings.
    const before = status.startsWith('A') ? undefined : await gitBuf(top, ['show', `${base}:${rel}`]);
    const after = status.startsWith('D') ? undefined : await gitBuf(top, ['show', `${result}:${rel}`]);
    const current = readCurrent(file);
    // A symlink is stored as its target path; a file through git's clean rules.
    const ours = !current ? undefined : current.link ? current.bytes : await stored(top, rel, file, current.bytes);
    const write = async (content: Buffer) => writeFile(file, current?.link ? content : await inUserStyle(top, result, rel, content, current?.bytes), await modeIn(top, result, rel));
    if (same(ours, after)) continue; // already the same
    if (same(ours, before)) {
      // Untouched in the project since the snapshot: take the subagent's version.
      if (after === undefined) rmSync(file, {force: true});
      else await write(after);
      merged.push(rel);
      continue;
    }
    const combined = ours && before && after ? await mergeText(ours, before, after) : undefined;
    if (combined) {
      await write(combined);
      merged.push(rel);
    } else conflicts.push(rel);
  }
  return {merged, conflicts};
}

export class Worktrees {
  private byAgent = new Map<number, Worktree>();
  private pending = new Map<number, Promise<Worktree | undefined>>();
  private top: Promise<string | undefined> | undefined;

  constructor(private readonly root: string, private readonly sessionId: () => string | undefined = () => undefined) {}

  get(agentId: number): Worktree | undefined {
    return this.byAgent.get(agentId);
  }

  /** The agent's worktree, created now if it has none. Undefined outside git (it works in place). */
  async ensure(agentId: number): Promise<Worktree | undefined> {
    const have = this.byAgent.get(agentId);
    if (have) return have;
    const inflight = this.pending.get(agentId);
    if (inflight) return inflight;
    const p = this.create(agentId).finally(() => this.pending.delete(agentId));
    this.pending.set(agentId, p);
    return p;
  }

  private async create(agentId: number): Promise<Worktree | undefined> {
    const top = await (this.top ??= repoTop(this.root));
    if (!top) return undefined;
    const {commit, big} = await snapshot(top);
    const dir = path.join(reinHome(), 'worktrees', path.basename(top), `${this.sessionId() ?? 'session'}-agent${agentId}-${randomBytes(3).toString('hex')}`);
    mkdirSync(path.dirname(dir), {recursive: true});
    await git(top, ['worktree', 'add', '--detach', '--quiet', dir, commit]);
    const linked = await furnish(top, dir, big);
    let real = this.root;
    try {
      real = realpathSync.native(this.root);
    } catch {}
    const sub = path.relative(realpathSync.native(top), real);
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
    const common = path.resolve(dir, (await git(dir, ['rev-parse', '--git-common-dir'])).trim());
    const wt: Worktree = {root: sub ? path.join(dir, sub) : dir, dir, base: commit, linked, writable: [gitDir, path.join(common, 'objects')]};
    // Beside the worktree (never inside it: it would be merged back): lets a later start finish the
    // job if this process dies first.
    writeFileSync(`${dir}.json`, JSON.stringify({top, base: commit, linked: [...linked], pid: process.pid}));
    this.byAgent.set(agentId, wt);
    return wt;
  }

  /**
   * A worktree on a new branch (`git worktree add -b`), from the project's current commit: for work
   * that should come back as a branch to review (a triggered issue), not as changes in your tree.
   * Attach it to the agent with `adopt` right after spawning, before its first tool call.
   */
  async createBranch(branch: string): Promise<Worktree | undefined> {
    const top = await (this.top ??= repoTop(this.root));
    if (!top) return undefined;
    const dir = path.join(reinHome(), 'worktrees', path.basename(top), branch.replace(/[^\w.-]+/g, '-'));
    mkdirSync(path.dirname(dir), {recursive: true});
    await git(top, ['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
    const linked = await furnish(top, dir, []);
    let real = this.root;
    try {
      real = realpathSync.native(this.root);
    } catch {}
    const sub = path.relative(realpathSync.native(top), real);
    const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).trim();
    const common = path.resolve(dir, (await git(dir, ['rev-parse', '--git-common-dir'])).trim());
    const base = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    return {root: sub ? path.join(dir, sub) : dir, dir, base, linked, writable: [gitDir, path.join(common, 'objects'), path.join(common, 'refs'), path.join(common, 'logs')], branch};
  }

  adopt(agentId: number, wt: Worktree): void {
    this.byAgent.set(agentId, wt);
  }

  /**
   * The agent ended: merge its changes into the project and delete the worktree. On conflicts the
   * worktree stays (its path is in `kept`) so the main agent can merge those files by hand.
   */
  async settle(agentId: number): Promise<MergeResult | undefined> {
    await this.pending.get(agentId);
    const wt = this.byAgent.get(agentId);
    if (!wt) return undefined;
    this.byAgent.delete(agentId);
    if (wt.branch) return keepBranch(wt);
    const top = (await this.top)!;
    const {commit} = await snapshot(wt.dir, wt.linked);
    return finish(top, wt.dir, wt.base, commit, wt.linked);
  }

  /**
   * Worktrees left by a Rein that exited or crashed before its subagents finished: merge their work
   * into the project now, so nothing done is lost.
   */
  async recover(): Promise<MergeResult[]> {
    const top = await (this.top ??= repoTop(this.root));
    if (!top) return [];
    const folder = path.join(reinHome(), 'worktrees', path.basename(top));
    let files: string[] = [];
    try {
      files = readdirSync(folder).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: MergeResult[] = [];
    for (const f of files) {
      const dir = path.join(folder, f.slice(0, -5));
      let meta: {top: string; base: string; linked: string[]; pid: number};
      try {
        meta = JSON.parse(readFileSync(path.join(folder, f), 'utf8'));
      } catch {
        continue;
      }
      if (meta.top !== top || alive(meta.pid)) continue;
      if (!existsSync(dir)) {
        rmSync(path.join(folder, f), {force: true});
        continue;
      }
      try {
        const linked = new Set(meta.linked);
        const {commit} = await snapshot(dir, linked);
        out.push(await finish(top, dir, meta.base, commit, linked));
      } catch {}
    }
    await git(top, ['worktree', 'prune']).catch(() => '');
    return out;
  }

  /** Session end: settle what's left (merging keeps the work, as if it had been done in place). */
  async settleAll(): Promise<void> {
    for (const id of [...this.byAgent.keys()]) await this.settle(id).catch(() => undefined);
  }
}

/**
 * A tool call's arguments with the project's absolute paths pointed at the worktree (the agent may
 * have learned them before it was moved, or from the main agent's task).
 */
export function retarget<T>(args: T, from: string, to: string): T {
  if (from === to) return args;
  const re = new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/\\\\\\s"'\`:;)])`, 'g');
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? v.replace(re, to) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(args) as T;
}

/** The note added to a subagent's report after its changes were merged back. */
export function mergeNote(r: MergeResult): string | undefined {
  if (r.branch)
    return `[Its work is on the branch ${r.branch}${r.commits?.length ? ` (${r.commits.length} commit${r.commits.length > 1 ? 's' : ''}: ${r.commits.slice(0, 5).join('; ')})` : ' (no commits)'}, in the worktree ${r.kept}. Nothing was merged into the project.]`;
  const parts: string[] = [];
  if (r.commits?.length)
    parts.push(
      `It worked in a private copy of the project, so the commit${r.commits.length > 1 ? 's' : ''} it made there (${r.commits.slice(0, 5).join('; ')}${r.commits.length > 5 ? '; …' : ''}) are NOT on the user's branch: their changes are in the working tree, uncommitted. Commit them yourself if a commit is wanted (the originals are kept at ${r.ref}).`,
    );
  if (r.merged.length) parts.push(`Its file changes were merged into the project: ${r.merged.slice(0, 20).join(', ')}${r.merged.length > 20 ? ` and ${r.merged.length - 20} more` : ''}.`);
  if (r.conflicts.length && r.kept)
    parts.push(
      `These files were also changed in the project while it worked, on the same lines, so they were NOT merged: ${r.conflicts.join(', ')}. Its versions are in ${r.kept} (same relative paths); merge them into the project yourself.`,
    );
  return parts.length ? `[${parts.join(' ')}]` : undefined;
}

const alive = (pid: number) => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Merge a worktree's changes into the project; delete it unless there were conflicts. */
async function finish(top: string, dir: string, base: string, result: string, linked: ReadonlySet<string>): Promise<MergeResult> {
  const kept = await keepCommits(top, dir, base);
  const {merged, conflicts} = await mergeInto(top, base, result, linked);
  return {...(await finishMerged(top, dir, merged, conflicts, linked)), ...kept};
}

/**
 * Commits the subagent made in its worktree (its HEAD moved past the snapshot). Done in place they
 * would sit on the user's branch; here they'd vanish with the worktree. Keep them under
 * refs/rein/worktrees/<name> so they can be cherry-picked, and report them.
 */
async function keepCommits(top: string, dir: string, base: string): Promise<{commits: string[]; ref: string} | undefined> {
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s.trim()).catch(() => '');
  if (!head || head === base) return undefined;
  const log = (await git(dir, ['log', '--format=%h %s', `${base}..${head}`]).catch(() => '')).trim();
  if (!log) return undefined;
  const ref = `refs/rein/worktrees/${path.basename(dir)}`;
  await git(top, ['update-ref', ref, head]).catch(() => '');
  return {commits: log.split('\n'), ref};
}

async function finishMerged(top: string, dir: string, merged: string[], conflicts: string[], linked: ReadonlySet<string>): Promise<MergeResult> {
  if (conflicts.length) {
    // Kept for the conflicting files; no longer a pending job.
    rmSync(`${dir}.json`, {force: true});
    return {merged, conflicts, kept: dir};
  }
  // Remove our links (node_modules…) first: deleting the worktree must never reach through one
  // into the project's own folders (a Windows junction especially).
  for (const rel of linked) {
    const link = path.join(dir, rel);
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link); // a junction on Windows
      } catch {}
    }
  }
  await git(top, ['worktree', 'remove', '--force', dir]).catch(() => '');
  rmSync(dir, {recursive: true, force: true}); // whatever git left behind (it can't always on Windows)
  await git(top, ['worktree', 'prune']).catch(() => '');
  rmSync(`${dir}.json`, {force: true});
  return {merged, conflicts};
}

const ARTIFACTS = ['**/__pycache__/**', '**/*.pyc', '**/.pytest_cache/**', '**/.DS_Store', '**/.mypy_cache/**', '**/.ruff_cache/**'];

/** Issue work: commit what's left on its branch and keep the worktree; nothing touches the project. */
async function keepBranch(wt: Worktree): Promise<MergeResult> {
  const linked = [...wt.linked];
  // Build leftovers (tests ran there) aren't the agent's work.
  const exclude = [...linked.map((p) => `:(exclude)${p}`), ...ARTIFACTS.map((g) => `:(exclude,glob)${g}`)];
  const status = (await git(wt.dir, ['status', '--porcelain', '--', '.', ...exclude])).split('\n').filter((l) => l.trim());
  if (status.length) {
    await git(wt.dir, ['add', '-A', '--', '.', ...exclude]);
    await git(wt.dir, ['-c', 'user.name=Rein', '-c', 'user.email=rein@localhost', 'commit', '--quiet', '-m', `Rein: work in progress on ${wt.branch}`]).catch(() => '');
  }
  const commits = (await git(wt.dir, ['log', '--format=%h %s', `${wt.base}..HEAD`])).split('\n').filter(Boolean);
  return {merged: [], conflicts: [], kept: wt.dir, branch: wt.branch, commits};
}
