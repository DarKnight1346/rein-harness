import {isWindows, killTree, shellFor} from '../util/platform.js';
import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import stripAnsi from 'strip-ansi';
import {wrap, type SandboxSpec} from './sandbox.js';

export type Shell = {
  id: number;
  command: string;
  cwd: string;
  background: boolean;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'exited' | 'killed' | 'timeout';
  exitCode?: number | null;
  /** Output lines (stdout + stderr, ANSI stripped, carriage-return progress collapsed). */
  lines: string[];
  /** Lines dropped from the front when the buffer was capped. */
  dropped: number;
  /** Subagent that started it (its foreground output shows in the subagent window, not a popup). */
  origin?: {agentId: number; name: string};
  /** Ran inside the OS sandbox (see sandbox.ts). */
  sandboxed?: boolean;
};

const MAX_LINES = 5000;
const MAX_LINE_CHARS = 2000;
/**
 * An unfinished line longer than this is cut: output that never sends a newline (a UEFI firmware
 * console on `-serial stdio`, a spinner redrawing with \r for hours) must not grow one string
 * without bound while the command runs.
 */
const MAX_PARTIAL_CHARS = 16_000;
/** Finished commands keep their last lines, and only the most recent ones keep any output. */
const FINISHED_MAX_LINES = 2000;
const FINISHED_WITH_OUTPUT = 50;

/**
 * A stored line as its own string. Slicing or splitting a big string can return a view that keeps
 * the whole original alive in V8 (a 2,000-char line pinning a 60 MB stream); a copy doesn't.
 */
const own = (s: string) => (s.length > 12 ? Buffer.from(s, 'utf8').toString('utf8') : s);
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Processes started by the agent's shell tool. Foreground runs block the tool call (the UI shows a
 * live output window); background runs return at once and keep logging here. Each process gets its
 * own process group so kill() takes its children down too. Emits `change` (any update) and
 * `foreground` (shell started in the foreground).
 */
export class ShellManager extends EventEmitter {
  private nextId = 1;
  private shells = new Map<number, Shell>();
  private procs = new Map<number, ChildProcess>();
  /** Unfinished last line per `${id}:out|err` (stdout and stderr interleave by line, never mid-line). */
  private partial = new Map<string, string>();

  list(): Shell[] {
    return [...this.shells.values()];
  }

  get(id: number): Shell | undefined {
    return this.shells.get(id);
  }

  running(opts: {background?: boolean} = {}): Shell[] {
    return this.list().filter((s) => s.status === 'running' && (opts.background === undefined || s.background === opts.background));
  }

  /** Start `command` with the user's shell in `cwd`. Resolves when it ends (foreground) or at once (background). */
  /** `maxMs`: the user's cap (0/undefined = none); the agent's `timeoutMs` is clamped to it. */
  start(command: string, opts: {cwd: string; background: boolean; timeoutMs?: number; maxMs?: number; origin?: Shell['origin']; sandbox?: SandboxSpec}): {shell: Shell; done: Promise<Shell>} {
    const shell: Shell = {id: this.nextId++, command, cwd: opts.cwd, background: opts.background, startedAt: Date.now(), status: 'running', lines: [], dropped: 0, origin: opts.origin};
    this.shells.set(shell.id, shell);
    const plain = shellFor(command);
    const boxed = wrap(plain, opts.sandbox);
    if (boxed) shell.sandboxed = true;
    const sh = boxed ?? plain;
    const child = spawn(sh.file, sh.args, {
      cwd: opts.cwd,
      env: {...process.env, FORCE_COLOR: '0', CI: process.env.CI ?? '1', PAGER: 'cat', GIT_PAGER: 'cat'},
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group → killTree reaches children (dev servers, watchers). Windows uses
      // taskkill /T instead, and a detached child there would open its own console window.
      detached: !isWindows,
      windowsHide: true,
    });
    shell.pid = child.pid;
    this.procs.set(shell.id, child);
    child.stdout?.on('data', (d: Buffer) => this.append(shell, 'out', d.toString()));
    child.stderr?.on('data', (d: Buffer) => this.append(shell, 'err', d.toString()));
    const wanted = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const timeout = opts.background ? undefined : opts.maxMs ? Math.min(opts.maxMs, wanted) : wanted;
    const timer = timeout ? setTimeout(() => this.kill(shell.id, 'timeout'), timeout) : undefined;
    const done = new Promise<Shell>((resolve) => {
      const finish = (code: number | null, err?: Error) => {
        clearTimeout(timer);
        this.flushPartial(shell);
        if (err) shell.lines.push(`[failed to start: ${err.message}]`);
        if (shell.status === 'running') shell.status = 'exited';
        shell.exitCode = code;
        shell.endedAt = Date.now();
        this.procs.delete(shell.id);
        this.trimFinished(shell);
        this.emit('change', shell);
        resolve(shell);
      };
      child.on('error', (err) => finish(null, err));
      child.on('close', (code) => finish(code));
    });
    if (!opts.background) this.emit('foreground', shell);
    this.emit('change', shell);
    return {shell, done};
  }

  kill(id: number, reason: 'killed' | 'timeout' = 'killed'): boolean {
    const child = this.procs.get(id);
    const shell = this.shells.get(id);
    if (!child || !shell || shell.status !== 'running') return false;
    shell.status = reason;
    killTree(child.pid, 'SIGTERM');
    // Escalate if it ignores SIGTERM.
    setTimeout(() => {
      if (this.procs.has(id)) killTree(child.pid, 'SIGKILL');
    }, 3000).unref();
    this.emit('change', shell);
    return true;
  }

  /** Stop every running foreground command (the user interrupted the agent). */
  killForeground(): void {
    for (const s of this.running({background: false})) this.kill(s.id);
  }

  killAll(): void {
    for (const s of this.running()) this.kill(s.id);
  }

  /** Last `n` lines as text (for the model). */
  tail(shell: Shell, n = 200): string {
    const lines = shell.lines.slice(-n);
    const skipped = shell.dropped + shell.lines.length - lines.length;
    return (skipped ? `[… ${skipped} earlier lines omitted]\n` : '') + lines.join('\n');
  }

  private append(shell: Shell, stream: 'out' | 'err', chunk: string): void {
    const key = `${shell.id}:${stream}`;
    const text = (this.partial.get(key) ?? '') + stripAnsi(chunk);
    const parts = text.split('\n');
    let rest = parts.pop() ?? '';
    for (const line of parts) this.push(shell, line);
    if (rest.length > MAX_PARTIAL_CHARS) {
      // No newline in sight: a \r redraw only needs its last state; anything else becomes a line.
      const cr = rest.lastIndexOf('\r');
      if (cr >= 0) rest = own(rest.slice(cr + 1));
      if (rest.length > MAX_PARTIAL_CHARS) {
        this.push(shell, rest);
        rest = '';
      }
    }
    this.partial.set(key, rest);
    this.emit('change', shell);
  }

  /** A finished command keeps its last lines; only the most recent finished ones keep output at all. */
  private trimFinished(shell: Shell): void {
    if (shell.lines.length > FINISHED_MAX_LINES) {
      const drop = shell.lines.length - FINISHED_MAX_LINES;
      shell.lines.splice(0, drop);
      shell.dropped += drop;
    }
    const finished = this.list().filter((s) => s.status !== 'running');
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_WITH_OUTPUT))) {
      if (!old.lines.length) continue;
      old.dropped += old.lines.length;
      old.lines = [];
    }
  }

  private flushPartial(shell: Shell): void {
    for (const stream of ['out', 'err']) {
      const rest = this.partial.get(`${shell.id}:${stream}`);
      if (rest) this.push(shell, rest);
      this.partial.delete(`${shell.id}:${stream}`);
    }
  }

  private push(shell: Shell, raw: string): void {
    // Progress bars redraw with \r: keep only the final state of the line.
    const line = raw.includes('\r') ? raw.split('\r').filter(Boolean).at(-1) ?? '' : raw;
    shell.lines.push(own(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line));
    if (shell.lines.length > MAX_LINES) {
      const drop = shell.lines.length - MAX_LINES;
      shell.lines.splice(0, drop);
      shell.dropped += drop;
    }
  }
}

export function shellStatusText(s: Shell, now = Date.now()): string {
  const secs = Math.round(((s.endedAt ?? now) - s.startedAt) / 1000);
  const dur = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  if (s.status === 'running') return `running ${dur}`;
  if (s.status === 'timeout') return `timed out after ${dur}`;
  if (s.status === 'killed') return `killed after ${dur}`;
  return `exit ${s.exitCode ?? '?'} after ${dur}`;
}
