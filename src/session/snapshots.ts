import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {reinHome} from '../store/paths.js';
import {run} from '../util/proc.js';

/**
 * Whole-project snapshots for /rewind, so changes made through `shell` (sed, codemods, formatters,
 * generators) can be undone too. Before each user message the working tree is recorded in a
 * private git store (~/.rein/checkpoints/<session>/tree.git) — separate from the project's own
 * .git, which is never touched. .gitignore is respected, so build output / node_modules aren't
 * tracked. Restoring only rewrites the files that differ between the snapshot and now.
 */
const TIMEOUT_MS = 30_000;

export class TreeSnapshots {
  private trees: Record<string, string> | undefined;
  private loadedFor: string | undefined;
  /** Off for this conversation after a failure (no git, too slow…); per-file checkpoints still work. */
  private disabled = false;

  /** `store`: a sub-store name, for the other repos of a workspace (the launch repo keeps the session folder itself). */
  constructor(private readonly root: string, private readonly sessionId: () => string, private readonly store?: string) {}

  private dir = () => path.join(reinHome(), 'checkpoints', this.sessionId(), ...(this.store ? ['repos', this.store] : []));
  private gitDir = () => path.join(this.dir(), 'tree.git');

  /** Every git call: no hooks, no gc, and byte-exact (no line-ending conversion, see init). */
  private git(args: string[], index = path.join(this.gitDir(), 'index')) {
    return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.eol=lf', ...args], {
      timeoutMs: TIMEOUT_MS,
      cwd: this.root,
      env: {...process.env, GIT_DIR: this.gitDir(), GIT_WORK_TREE: this.root, GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: '0'},
    });
  }

  private load(): Record<string, string> {
    if (this.loadedFor !== this.sessionId()) {
      this.loadedFor = this.sessionId();
      this.disabled = false;
      try {
        this.trees = JSON.parse(readFileSync(path.join(this.dir(), 'trees.json'), 'utf8'));
      } catch {
        this.trees = {};
      }
    }
    return this.trees!;
  }

  /** Record the tree as of now; returns the tree id. */
  private async writeTree(): Promise<string> {
    mkdirSync(this.dir(), {recursive: true, mode: 0o700});
    const init = await this.git(['rev-parse', '--git-dir']);
    if (init.code !== 0) {
      const r = await this.git(['init', '-q']);
      if (r.code !== 0) throw new Error(r.stderr.trim() || 'git init failed');
      // Never record the project's own repo metadata or Rein's per-project state.
      writeFileSync(path.join(this.gitDir(), 'info', 'exclude'), '.git\n.rein/checkpoints/\n');
      // Byte-exact: overrides the project's .gitattributes — no eol conversion, no filters (LFS…).
      writeFileSync(path.join(this.gitDir(), 'info', 'attributes'), '* -text -filter -diff -merge\n');
      await this.seedFromProject();
    }
    const add = await this.git(['add', '-A', '--ignore-errors', '--', '.']);
    if (add.code !== 0 && !/warning|error: unable to index/i.test(add.stderr)) throw new Error(add.stderr.trim() || 'git add failed');
    const tree = await this.git(['write-tree']);
    if (tree.code !== 0) throw new Error(tree.stderr.trim() || 'git write-tree failed');
    return tree.stdout.trim();
  }

  /**
   * A project that's a git repo already has every tracked file hashed: borrow its objects (alternates)
   * and start from a copy of its index, so the first snapshot only hashes what changed instead of the
   * whole tree (a kernel checkout: 30 s and a timeout before, about as long as `git status` now). Any
   * problem (a split index, a worktree layout we don't expect) leaves the store as it was: a full add.
   */
  private async seedFromProject(): Promise<void> {
    try {
      const where = await run('git', ['rev-parse', '--absolute-git-dir', '--git-common-dir'], {cwd: this.root, timeoutMs: 5000});
      if (where.code !== 0) return;
      const [gitDir, common] = where.stdout.trim().split('\n');
      if (!gitDir || !common) return;
      const objects = path.resolve(this.root, common, 'objects');
      const index = path.join(gitDir, 'index');
      if (!existsSync(objects) || !existsSync(index)) return;
      // A split index keeps its shared part in sharedindex.* next to it: a copy alone wouldn't load.
      if (readdirSync(gitDir).some((f) => f.startsWith('sharedindex.'))) return;
      const bytes = readFileSync(index);
      mkdirSync(path.join(this.gitDir(), 'objects', 'info'), {recursive: true});
      writeFileSync(path.join(this.gitDir(), 'objects', 'info', 'alternates'), `${objects}\n`);
      writeFileSync(path.join(this.gitDir(), 'index'), bytes);
    } catch {
      rmSync(path.join(this.gitDir(), 'index'), {force: true});
      rmSync(path.join(this.gitDir(), 'objects', 'info', 'alternates'), {force: true});
    }
  }

  /** The tree as it is now, recorded in the store (for spec traceability). */
  tree(): Promise<string> {
    return this.writeTree();
  }

  /** The line ranges (new side) each file changed between two trees; a pure deletion is the line it was at. */
  async hunks(from: string, to: string): Promise<{file: string; ranges: [number, number][]}[]> {
    const d = await this.git(['diff', '-U0', '--text', '--no-color', '--no-renames', '--no-ext-diff', from, to]); // --text: the store's attributes mark every file -diff
    if (d.code !== 0) throw new Error(d.stderr.trim() || 'git diff failed');
    const out: {file: string; ranges: [number, number][]}[] = [];
    let cur: {file: string; ranges: [number, number][]} | undefined;
    for (const line of d.stdout.split('\n')) {
      const f = line.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/);
      if (f) {
        cur = f[1] ? {file: f[1], ranges: []} : undefined;
        if (cur) out.push(cur);
        continue;
      }
      const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (h && cur) {
        const start = Number(h[1]);
        const n = h[2] === undefined ? 1 : Number(h[2]);
        cur.ranges.push([Math.max(1, start), Math.max(1, start + Math.max(n, 1) - 1)]);
      }
    }
    return out;
  }

  /** Snapshot before the user message at `turn` runs (once per turn). */
  async snapshot(turn: number): Promise<void> {
    const trees = this.load();
    if (this.disabled || trees[turn]) return;
    try {
      trees[turn] = await this.writeTree();
      writeFileSync(path.join(this.dir(), 'trees.json'), JSON.stringify(trees));
    } catch {
      this.disabled = true; // not a problem: per-file checkpoints still cover Rein's own edits
    }
  }

  has(turn: number): boolean {
    return !!this.load()[turn];
  }

  /** Files that differ now from the snapshot at `turn` (what restoring would change). */
  async changedSince(turn: number): Promise<string[]> {
    const target = this.load()[turn];
    if (!target || this.disabled) return [];
    try {
      const now = await this.writeTree();
      const diff = await this.git(['diff-tree', '-r', '--name-only', '--no-renames', now, target]);
      return diff.stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Put the working tree back to the snapshot at `turn`: files changed or deleted since are
   * restored, files created since are removed. Untracked-by-.gitignore files are left alone.
   */
  async restore(turn: number): Promise<{restored: string[]; removed: string[]}> {
    const target = this.load()[turn];
    if (!target) throw new Error('no snapshot for that message');
    const now = await this.writeTree();
    const diff = await this.git(['diff-tree', '-r', '--name-status', '--no-renames', now, target]);
    const restored: string[] = [];
    const removed: string[] = [];
    for (const line of diff.stdout.split('\n').filter(Boolean)) {
      const [status, ...rest] = line.split('\t');
      const file = rest.join('\t');
      if (status === 'D') {
        // In the current tree but not the snapshot: created since → remove.
        rmSync(path.join(this.root, file), {force: true});
        removed.push(file);
      } else restored.push(file);
    }
    if (restored.length) {
      // Write the snapshot's version of those files (through a scratch index, not the store's).
      const tmpIndex = path.join(this.gitDir(), 'index.restore');
      const readTree = await this.git(['read-tree', target], tmpIndex);
      if (readTree.code !== 0) throw new Error(readTree.stderr.trim());
      for (let i = 0; i < restored.length; i += 200) {
        const r = await this.git(['checkout-index', '-f', '--', ...restored.slice(i, i + 200)], tmpIndex);
        if (r.code !== 0) throw new Error(r.stderr.trim());
      }
      rmSync(tmpIndex, {force: true});
    }
    // Later snapshots no longer describe this history.
    const trees = this.load();
    for (const k of Object.keys(trees)) if (Number(k) >= turn) delete trees[k];
    writeFileSync(path.join(this.dir(), 'trees.json'), JSON.stringify(trees));
    return {restored, removed};
  }
}

/**
 * Cross-repo rewind: one snapshot per message across the launch repo and every other repo of the
 * workspace, so /rewind puts the whole system back to the same moment. Paths outside the launch
 * repo come back relative to it (`../api/src/x.ts`). A repo cloned later just has no older snapshots.
 */
export class WorkspaceSnapshots {
  private readonly main: TreeSnapshots;
  private readonly others = new Map<string, TreeSnapshots>();

  constructor(private readonly root: string, private readonly sessionId: () => string, private readonly repos: () => string[] = () => []) {
    this.main = new TreeSnapshots(root, sessionId);
  }

  private all(): [string, TreeSnapshots][] {
    const out: [string, TreeSnapshots][] = [[this.root, this.main]];
    for (const dir of this.repos()) {
      const abs = path.resolve(dir);
      if (abs === path.resolve(this.root)) continue;
      let s = this.others.get(abs);
      if (!s) this.others.set(abs, (s = new TreeSnapshots(abs, this.sessionId, `${path.basename(abs)}-${createHash('sha1').update(abs).digest('hex').slice(0, 8)}`)));
      out.push([abs, s]);
    }
    return out;
  }

  private rel = (dir: string, file: string) => (dir === this.root ? file : path.relative(this.root, path.join(dir, file)).split(path.sep).join('/'));

  async snapshot(turn: number): Promise<void> {
    await Promise.all(this.all().map(([, s]) => s.snapshot(turn)));
  }

  has(turn: number): boolean {
    return this.all().some(([, s]) => s.has(turn));
  }

  async changedSince(turn: number): Promise<string[]> {
    const lists = await Promise.all(this.all().map(async ([dir, s]) => (await s.changedSince(turn)).map((f) => this.rel(dir, f))));
    return lists.flat();
  }

  /** Restores every repo that has a snapshot for `turn`; a repo that fails doesn't stop the others. */
  async restore(turn: number): Promise<{restored: string[]; removed: string[]; failed: string[]}> {
    const out = {restored: [] as string[], removed: [] as string[], failed: [] as string[]};
    if (!this.has(turn)) throw new Error('no snapshot for that message');
    for (const [dir, s] of this.all()) {
      if (!s.has(turn)) continue;
      try {
        const r = await s.restore(turn);
        out.restored.push(...r.restored.map((f) => this.rel(dir, f)));
        out.removed.push(...r.removed.map((f) => this.rel(dir, f)));
      } catch (err) {
        out.failed.push(`${dir === this.root ? 'this repo' : path.basename(dir)}: ${(err as Error).message}`);
      }
    }
    return out;
  }
}
