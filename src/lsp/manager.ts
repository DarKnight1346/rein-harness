import {execFile, execFileSync} from 'node:child_process';
import path from 'node:path';
import type {Config} from '../store/config.js';
import {LspClient, type Diagnostic} from './client.js';
import {resolveServer, serverFor, type ServerSpec} from './servers.js';

/**
 * Rein's built-in code intelligence: language servers it runs itself, one per (project root,
 * language), started on first use, stopped when idle. Worktree copies get their own (they're a
 * different root). The headline use is the after-edit check: diagnostics before and after an edit
 * are compared, and only problems the edit introduced are reported back to the agent.
 */
const SEVERITY = ['', 'error', 'warning', 'info', 'hint'];
const REPORT_TIMEOUT_MS = 1500;
const MAX_REPORTED = 5;
const MAX_DEPENDENTS = 10;

export type Before = {root: string; files: {file: string; count: number; list?: Diagnostic[]; dependent?: boolean}[]};

/**
 * Files that likely import `file` (their text names it), so an edit that breaks a caller is caught
 * too: `git grep` for the module name, same language, at most a few. Empty outside a git repo.
 */
function dependents(file: string, root: string, exts: string[]): Promise<string[]> {
  const stem = path.basename(file).replace(/\.[^.]+$/, '');
  if (stem.length < 2 || stem === 'index' || stem === '__init__') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('git', ['grep', '-l', '-I', '-F', '-w', stem, '--', ...exts.map((e) => `*${e}`)], {cwd: root, timeout: 1000, maxBuffer: 1 << 20}, (err, out) => {
      if (err && !out) return resolve([]);
      const self = path.resolve(file);
      resolve(String(out).split('\n').filter(Boolean).map((f) => path.resolve(root, f)).filter((f) => f !== self).slice(0, MAX_DEPENDENTS));
    });
  });
}

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
        c = new LspClient(root, run.command, run.args, (f) => spec.languages[path.extname(f).toLowerCase()] ?? 'plaintext', run.initOptions ?? spec.initOptions?.(root));
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

  /** Before an edit: the current diagnostics of each file and of files that import it (opening them if needed). */
  async before(files: string[], root: string): Promise<Before> {
    const targets: {file: string; dependent: boolean}[] = files.map((file) => ({file, dependent: false}));
    for (const file of files) {
      const spec = serverFor(file);
      if (!spec || !this.client(file, root)) continue;
      for (const d of await dependents(file, root, Object.keys(spec.languages))) if (!targets.some((t) => t.file === d)) targets.push({file: d, dependent: true});
    }
    const out: Before = {root, files: []};
    await Promise.all(
      targets.map(async ({file, dependent}) => {
        const c = this.client(file, root);
        if (!c || !(await c.whenReady(REPORT_TIMEOUT_MS))) return;
        if (!c.isOpen(file)) {
          const n = c.publishCount(file);
          c.sync(file);
          await c.waitForDiagnostics(file, n, REPORT_TIMEOUT_MS);
        }
        out.files.push({file, count: c.publishCount(file), list: c.diagnostics(file), dependent});
      }),
    );
    return out;
  }

  /** After an edit: problems it introduced, as a short note for the tool result (undefined = none). */
  async after(b: Before): Promise<string | undefined> {
    // Send every change first, then collect: callers are re-checked against the new text.
    const checks = b.files.map((f) => ({...f, c: this.client(f.file, b.root, false)})).map((f) => ({...f, changed: !!f.c?.sync(f.file)}));
    const relevant = checks.filter((x) => x.c && (x.changed || x.dependent)); // unchanged (or gone): nothing new to report
    // Push servers: wait once per server for its re-check to settle (pull servers are asked per file).
    await Promise.all([...new Set(relevant.map((x) => x.c!))].filter((c) => !c.pull).map((c) => c.waitSettled(relevant.filter((x) => x.c === c).map((x) => ({file: x.file, after: x.count})), REPORT_TIMEOUT_MS)));
    const results = await Promise.all(
      relevant.map(async ({file, count, list, c}) => {
        if (c!.pull && !(await c!.waitForDiagnostics(file, count, REPORT_TIMEOUT_MS))) return [];
        const now = c!.diagnostics(file) ?? [];
        return (list ? newProblems(list, now) : now.filter((d) => (d.severity ?? 1) === 1)).map((d) => formatDiagnostic(d, file, b.root));
      }),
    );
    const all = results.flat();
    const total = all.length;
    const lines = all.slice(0, MAX_REPORTED);
    if (!total) return undefined;
    return `[Diagnostics: this edit introduced ${total} problem${total === 1 ? '' : 's'}${total > lines.length ? ` (first ${lines.length})` : ''}:\n${lines.join('\n')}\nFix ${total === 1 ? 'it' : 'them'} before moving on.]`;
  }

  /** A file's (or every open file's) current problems, for the diagnostics tool. */
  async diagnostics(root: string, file?: string): Promise<string | undefined> {
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
    for (const c of this.clients.values()) if (c.root === root) for (const {file} of c.allDiagnostics()) c.sync(file);
  }

  /** Stop the servers for a root (a worktree that merged back). */
  async stopRoot(root: string): Promise<void> {
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
      return {server: k.split('|').pop()!, root: c.root, pid: c.proc.pid, rssMB, files: c.allDiagnostics().length, idleMin: Math.round((Date.now() - c.lastUsed) / 60_000)};
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
