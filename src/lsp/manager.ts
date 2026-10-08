import {execFile, execFileSync} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import path from 'node:path';
import type {Config} from '../store/config.js';
import {LspClient, type Diagnostic} from './client.js';
import {filePatterns, installable, languageIdFor, resolveServer, serverFor, type ServerSpec} from './servers.js';

/**
 * Rein's built-in code intelligence: language servers it runs itself, one per (project root,
 * language), started on first use, stopped when idle. Worktree copies get their own (they're a
 * different root). The headline use is the after-edit check: diagnostics before and after an edit
 * are compared, and only problems the edit introduced are reported back to the agent.
 */
const SEVERITY = ['', 'error', 'warning', 'info', 'hint'];
const REPORT_TIMEOUT_MS = 1500;
const MAX_TURN_REPORTED = 10;
const MAX_DEPENDENTS = 10;

/** Files a before() call looked at (for after(): which to re-sync). */
const files = (b: Before, turn: Map<string, {root: string; file: string}>) => [...new Set([...b.files.map((f) => f.file), ...[...turn.values()].filter((t) => t.root === b.root).map((t) => t.file)])];

export type Before = {root: string; files: {file: string; count: number; list?: Diagnostic[]; dependent?: boolean}[]; missing?: ServerSpec[]};

/** Vendored and generated trees: code the agent didn't write, never a caller worth checking. */
const THIRD_PARTY = ['vendor', 'node_modules', 'third_party', 'third-party', '.venv', 'venv', 'site-packages', 'dist', 'build'];

/**
 * Files that likely import `file` (their text names it), so an edit that breaks a caller is caught
 * too: `git grep` for the module name, same language, at most a few. Empty outside a git repo.
 */
function dependents(file: string, root: string, patterns: string[]): Promise<string[]> {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  if (stem.length < 2 || stem === 'index' || stem === '__init__') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('git', ['grep', '-l', '-I', '-F', '-w', stem, '--', ...patterns, ...THIRD_PARTY.map((d) => `:(exclude,glob)**/${d}/**`)], {cwd: root, timeout: 1000, maxBuffer: 1 << 20}, (err, out) => {
      if (err && !out) return resolve([]);
      const self = path.resolve(file);
      resolve(String(out).split('\n').filter(Boolean).map((f) => path.resolve(root, f)).filter((f) => f !== self).slice(0, MAX_DEPENDENTS));
    });
  });
}

/** Roots as real paths, like the file paths the tools resolve (macOS /var → /private/var). */
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const keyOf = (d: Diagnostic) => `${d.severity ?? 1}|${d.code ?? ''}|${d.message}`;

export function formatDiagnostic(d: Diagnostic, file: string, root: string): string {
  const rel = path.relative(root, file) || file;
  const sev = SEVERITY[d.severity ?? 1] ?? 'error';
  return `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}${d.code !== undefined ? ` ${d.source ? `${d.source} ` : ''}${d.code}` : d.source ? ` ${d.source}` : ''}: ${d.message.replace(/\s+/g, ' ').slice(0, 300)}`;
}

/** Problems in `after` that weren't in `before` (by message, severity and code, not position: lines move). */
export function newProblems(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
  const left = new Map<string, number>();
  for (const d of before) left.set(keyOf(d), (left.get(keyOf(d)) ?? 0) + 1);
  const out: Diagnostic[] = [];
  for (const d of after) {
    const k = keyOf(d);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else if ((d.severity ?? 1) <= 2) out.push(d);
  }
  return out;
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  private sweep: NodeJS.Timeout | undefined;

  constructor(private readonly opts: {config: () => Config}) {}

  private enabled() {
    return (this.opts.config().lsp ?? 'auto') !== 'off';
  }

  /** The server for a file, if Rein has one for its language and it's installed. */
  spec(file: string, root?: string): {spec: ServerSpec; installed: boolean} | undefined {
    const spec = serverFor(file);
    if (!spec) return undefined;
    return {spec, installed: !!resolveServer(spec, this.opts.config().lspServers ?? {}, root ?? process.cwd())};
  }

  /** The running client for a file's root and language, started if needed. */
  client(file: string, root: string, start = true): LspClient | undefined {
    if (!this.enabled()) return undefined;
    root = real(root);
    const spec = serverFor(file);
    if (!spec) return undefined;
    const key = `${root}|${spec.id}`;
    let c = this.clients.get(key);
    if (c && !c.alive) {
      this.clients.delete(key);
      c = undefined;
    }
    if (!c && start) {
      const run = resolveServer(spec, this.opts.config().lspServers ?? {}, root);
      if (!run) return undefined;
      try {
        c = new LspClient(root, run.command, run.args, (f) => languageIdFor(spec, f), run.initOptions ?? spec.initOptions?.(root), run.env);
      } catch {
        return undefined;
      }
      this.clients.set(key, c);
      this.startSweep();
    }
    return c;
  }

  /** Start the server and open the file in the background (a read or an edit coming up). */
  prewarm(file: string, root: string): void {
    const c = this.client(file, root);
    if (c) void c.whenReady(30_000).then((ok) => ok && c.sync(file));
  }

  /**
   * Files this turn changed (and files importing them), with their problems before the first
   * change: what the end-of-turn check compares against. Keyed by root + file.
   */
  private turn = new Map<string, {root: string; file: string; count: number; list?: Diagnostic[]; created?: boolean; dependent?: boolean}>();

  /**
   * Before an edit: the first time this turn a file (or a file importing it) is touched, remember
   * its problems as they are now. Problems are reported once, when the turn ends (turnEnd): in the
   * middle of a change, breakage the agent is about to fix is expected, and reporting it after
   * every edit only costs tokens.
   */
  async before(files: string[], root: string): Promise<Before> {
    root = real(root);
    const targets: {file: string; dependent: boolean}[] = files.map((file) => ({file, dependent: false}));
    const missing: ServerSpec[] = [];
    for (const file of files) {
      const spec = serverFor(file);
      if (spec && this.enabled() && !this.hinted.has(spec.id) && !resolveServer(spec, this.opts.config().lspServers ?? {}, root)) missing.push(spec);
      if (!spec || !this.client(file, root)) continue;
      if (this.turn.has(`${root}|${file}`)) continue; // already tracked this turn (dependents too)
      for (const d of await dependents(file, root, filePatterns(spec))) if (!targets.some((t) => t.file === d)) targets.push({file: d, dependent: true});
    }
    const out: Before = {root, files: [], missing};
    await Promise.all(
      targets.map(async ({file, dependent}) => {
        const key = `${root}|${file}`;
        if (this.turn.has(key)) return;
        // A file being created has no problems yet: nothing to wait for.
        if (!existsSync(file)) return void this.turn.set(key, {root, file, count: 0, created: true});
        const c = this.client(file, root);
        if (!c || !(await c.whenReady(REPORT_TIMEOUT_MS))) return;
        if (!c.isOpen(file)) {
          const n = c.publishCount(file);
          c.sync(file);
          await c.waitForDiagnostics(file, n, REPORT_TIMEOUT_MS);
        }
        this.turn.set(key, {root, file, count: c.publishCount(file), list: c.diagnostics(file), dependent});
        out.files.push({file, count: c.publishCount(file), list: c.diagnostics(file), dependent});
      }),
    );
    return out;
  }

  /** After an edit: tell the servers (no waiting); the only note is a missing server, once. */
  async after(b: Before): Promise<string | undefined> {
    for (const f of files(b, this.turn)) this.client(f, b.root, false)?.sync(f);
    return this.missingHint(b.missing ?? []);
  }

  /**
   * The turn is ending: problems the turn's changes left that weren't there before, as one note
   * for the agent (undefined = none). The tracking starts over either way, so a turn is nudged at
   * most once about the same problems.
   */
  async turnEnd(): Promise<string | undefined> {
    const tracked = [...this.turn.values()];
    this.turn.clear();
    if (!tracked.length) return undefined;
    const checks = tracked.map((t) => ({...t, c: this.client(t.file, t.root, false)})).filter((t) => t.c);
    for (const t of checks) t.c!.sync(t.file);
    await Promise.all([...new Set(checks.map((x) => x.c!))].filter((c) => !c.pull).map((c) => c.waitSettled(checks.filter((x) => x.c === c).map((x) => ({file: x.file, after: x.count})), REPORT_TIMEOUT_MS)));
    const reported: {root: string; file: string; keys: string[]}[] = [];
    const results = await Promise.all(
      checks.map(async ({file, count, list, created, dependent, c, root}) => {
        // No "before" to compare with: the server hadn't reported on the file yet when the turn first
        // touched it (a big file, a slow first parse). Its errors can't be told apart from ones that
        // were already there (a kernel tree without its build config has hundreds), so it's skipped.
        // A file the turn created had none before: everything in it is new.
        if (!list && !created) return [];
        if (c!.pull && !(await c!.waitForDiagnostics(file, count, REPORT_TIMEOUT_MS))) return [];
        const now = c!.diagnostics(file) ?? [];
        // A caller the agent didn't edit: only errors (a broken call). Its warnings were often still
        // being computed when the "before" was taken (gopls' staticcheck), so they'd read as new.
        const found = (list ? newProblems(list, now) : now.filter((d) => (d.severity ?? 1) === 1)).filter((d) => !dependent || (d.severity ?? 1) === 1);
        if (found.length) reported.push({root, file, keys: found.map(keyOf)});
        return found.map((d) => formatDiagnostic(d, file, root));
      }),
    );
    const all = results.flat();
    this.reported = reported;
    if (!all.length) return undefined;
    const lines = all.slice(0, MAX_TURN_REPORTED);
    return `Your changes left ${all.length} problem${all.length === 1 ? '' : 's'} the code didn't have before${all.length > lines.length ? ` (first ${lines.length})` : ''}, from the language server:\n${lines.join('\n')}\nFix ${all.length === 1 ? 'it' : 'them'}, or if ${all.length === 1 ? 'it should' : 'they should'} stay, say why in your reply.`;
  }

  /** What the last end-of-turn check reported, so a later turn can tell whether it was fixed. */
  private reported: {root: string; file: string; keys: string[]}[] = [];

  /**
   * The problems the last check reported that are still there now (formatted), for escalation:
   * the agent was told and its next turn didn't fix them. Empty when nothing was reported.
   */
  async stillThere(): Promise<string[]> {
    const before = this.reported;
    this.reported = [];
    const out: string[] = [];
    for (const r of before) {
      const c = this.client(r.file, r.root, false);
      if (!c) continue;
      const n = c.publishCount(r.file);
      c.sync(r.file);
      await c.waitForDiagnostics(r.file, n, REPORT_TIMEOUT_MS);
      for (const d of c.diagnostics(r.file) ?? []) if (r.keys.includes(keyOf(d))) out.push(formatDiagnostic(d, r.file, r.root));
    }
    return out;
  }

  /** Servers the agent was already told are missing (once per session each). */
  private hinted = new Set<string>();

  /** Edits to a language whose server isn't installed: say so once, so the agent can offer it. */
  private missingHint(missing: ServerSpec[]): string | undefined {
    const fresh = missing.filter((s) => !this.hinted.has(s.id));
    if (!fresh.length) return undefined;
    for (const s of fresh) this.hinted.add(s.id);
    return fresh
      .map((s) => {
        const can = installable(s);
        return can.ok
          ? `[Code intelligence: ${s.name} isn't installed, so this change wasn't checked for errors. Offer the user to install it (lsp_install {server: "${s.id}"}, it asks them).]`
          : `[Code intelligence: ${s.name} isn't installed, so this change wasn't checked for errors. Rein can't install it itself (${can.why}) — mention it to the user once if it would help.]`;
      })
      .join('\n');
  }

  /** A file's (or every open file's) current problems, for the diagnostics tool. */
  async diagnostics(root: string, file?: string): Promise<string | undefined> {
    root = real(root);
    if (file) {
      const c = this.client(file, root);
      if (!c || !(await c.whenReady(20_000))) return undefined;
      const n = c.publishCount(file);
      // Only wait when the server was told something new; unchanged files keep their last report.
      if (c.sync(file) || !n) await c.waitForDiagnostics(file, n, 8000);
      const list = c.diagnostics(file) ?? [];
      return list.length ? list.map((d) => formatDiagnostic(d, file, root)).join('\n') : 'No problems reported.';
    }
    const all = [...this.clients.values()].filter((c) => c.root === root).flatMap((c) => c.allDiagnostics().flatMap(({file: f, list}) => list.map((d) => formatDiagnostic(d, f, root))));
    return all.length ? all.join('\n') : undefined;
  }

  /** Shell commands may have changed files: re-sync every open file under this root. */
  resync(root: string): void {
    root = real(root);
    for (const c of this.clients.values()) if (c.root === root) for (const file of c.openFiles()) c.sync(file);
  }

  /** Stop the servers for a root (a worktree that merged back). */
  async stopRoot(root: string): Promise<void> {
    root = real(root);
    for (const [k, c] of this.clients) if (c.root === root) {
      this.clients.delete(k);
      await c.shutdown();
    }
  }

  /** Stop servers that haven't been used for `lspIdleMinutes` (default 10). */
  async stopIdle(now = Date.now()): Promise<number> {
    const idleMs = (this.opts.config().lspIdleMinutes ?? 10) * 60_000;
    let stopped = 0;
    for (const [k, c] of this.clients) {
      if (now - c.lastUsed < idleMs && c.alive) continue;
      this.clients.delete(k);
      await c.shutdown();
      stopped++;
    }
    if (!this.clients.size && this.sweep) {
      clearInterval(this.sweep);
      this.sweep = undefined;
    }
    return stopped;
  }

  private startSweep() {
    if (this.sweep || process.env.VITEST) return;
    this.sweep = setInterval(() => void this.stopIdle(), 60_000);
    this.sweep.unref();
  }

  /** Running servers: what, where, memory (for /lsp). */
  status(): {server: string; root: string; pid?: number; rssMB?: number; files: number; idleMin: number}[] {
    return [...this.clients].map(([k, c]) => {
      let rssMB: number | undefined;
      try {
        if (c.proc.pid && process.platform !== 'win32') rssMB = Math.round(Number(execFileSync('ps', ['-o', 'rss=', '-p', String(c.proc.pid)], {encoding: 'utf8'}).trim()) / 1024);
      } catch {}
      return {server: k.split('|').pop()!, root: c.root, pid: c.proc.pid, rssMB, files: c.openFiles().length, idleMin: Math.round((Date.now() - c.lastUsed) / 60_000)};
    });
  }

  async closeAll(): Promise<void> {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.shutdown()));
  }
}
