import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import stripAnsi from 'strip-ansi';

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
};

const MAX_LINES = 5000;
const MAX_LINE_CHARS = 2000;
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
  start(command: string, opts: {cwd: string; background: boolean; timeoutMs?: number; maxMs?: number; origin?: Shell['origin']}): {shell: Shell; done: Promise<Shell>} {
    const shell: Shell = {id: this.nextId++, command, cwd: opts.cwd, background: opts.background, startedAt: Date.now(), status: 'running', lines: [], dropped: 0, origin: opts.origin};
    this.shells.set(shell.id, shell);
    const sh = process.env.SHELL || '/bin/sh';
    const child = spawn(sh, ['-c', command], {
      cwd: opts.cwd,
      env: {...process.env, FORCE_COLOR: '0', CI: process.env.CI ?? '1', PAGER: 'cat', GIT_PAGER: 'cat'},
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group → kill(-pid) reaches children (dev servers, watchers)
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
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    // Escalate if it ignores SIGTERM.
    setTimeout(() => {
      try {
        if (child.pid && this.procs.has(id)) process.kill(-child.pid, 'SIGKILL');
      } catch {}
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
    this.partial.set(key, parts.pop() ?? '');
    for (const line of parts) this.push(shell, line);
    this.emit('change', shell);
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
    shell.lines.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line);
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
