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
  /** The first lines, kept even when the buffer drops them: a build's first errors are there. */
  head?: string[];
  /** Subagent that started it (its foreground output shows in the subagent window, not a popup). */
  origin?: {agentId: number; name: string};
  /** Ran inside the OS sandbox (see sandbox.ts). */
  sandboxed?: boolean;
  /** Ran in the repo's dev environment (devEnvironment). */
  devEnv?: string;
  /** Runs in a pseudo-terminal (interactive: true): it can ask questions, the user can answer. */
  tty?: boolean;
  /** A terminal command that looks like it's waiting for the user (see waitingForInput). */
  waiting?: boolean;
  /** Stopped because it waited for input and nobody could answer (headless). */
  noUser?: boolean;
};

/** A running pseudo-terminal: node-pty when it loads, else `script` over pipes. */
type Term = {write(data: string): void; resize(cols: number, rows: number): void; raw: string; alt: boolean; quietTimer?: NodeJS.Timeout; kill?: () => void};

/** Bytes of raw terminal output kept to repaint the screen when the user takes over. */
const RAW_KEEP = 64 * 1024;
/** No output for this long, and it looks like a prompt: the command is waiting for the user. */
export const QUIET_MS = 1500;

let ptyModule: typeof import('@lydell/node-pty') | null | undefined;
async function loadPty(): Promise<typeof import('@lydell/node-pty') | null> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = process.env.REIN_NO_NODE_PTY ? null : await import('@lydell/node-pty');
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}
/** Load node-pty ahead of the first interactive command (it's an optional native dependency). */
export const preloadPty = () => void loadPty();

/**
 * Does a quiet terminal look like it's waiting for the user? A full-screen program (alternate
 * screen), a cursor left at the end of an unfinished line (`Name: `), or a last line that reads like
 * a question. A slow build that's just quiet isn't.
 */
export function waitingForInput(lastLine: string, partial: string, alt: boolean): boolean {
  if (alt) return true;
  if (partial.trim()) return true;
  return /(\?|:|>|\]|\)|\(y\/n\)|\[y\/n\]|password|passphrase|continue)\s*$/i.test(lastLine.trim());
}

const MAX_LINES = 5000;
const HEAD_LINES = 200;
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
  /** The secrets vault: its values go into every command's environment, and are masked in its output. */
  vault?: {env(): Record<string, string>; mask(text: string): string};
  /** More variables for every command (provenance: REIN_SESSION, REIN_MODEL, REIN_GOAL). */
  extraEnv?: () => Record<string, string>;
  /** devEnvironment: the repo's devcontainer or Nix/devbox shell for the agent's commands. */
  devEnv?: import('../env/devenv.js').DevEnv;
  /** sandbox "container": the conversation's container. */
  box?: import('../env/container.js').ContainerBox;
  private nextId = 1;
  private shells = new Map<number, Shell>();
  private procs = new Map<number, ChildProcess | {pid: number}>();
  private terms = new Map<number, Term>();
  /**
   * Someone can answer a terminal command's questions (the TUI sets it). Without a user (headless),
   * a command that waits for input is stopped instead of hanging until its timeout.
   */
  interactiveUser = false;
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
  start(command: string, opts: {cwd: string; background: boolean; timeoutMs?: number; maxMs?: number; origin?: Shell['origin']; sandbox?: SandboxSpec; tty?: boolean}): {shell: Shell; done: Promise<Shell>} {
    const shell: Shell = {id: this.nextId++, command, cwd: opts.cwd, background: opts.background, startedAt: Date.now(), status: 'running', lines: [], dropped: 0, origin: opts.origin};
    this.shells.set(shell.id, shell);
    // In the dev container, the container is the boundary: the OS sandbox isn't applied on top.
    const fromDev = this.devEnv?.apply(command, opts.cwd);
    const dev = fromDev ?? this.box?.apply(command, opts.cwd);
    const plain = shellFor(dev?.command ?? command);
    const boxed = dev?.container ? undefined : wrap(plain, opts.sandbox);
    if (dev) shell.devEnv = fromDev ? this.devEnv!.current().kind : 'container';
    if (boxed) shell.sandboxed = true;
    const sh = boxed ?? plain;
    if (opts.tty) return this.startTty(shell, sh, {...opts, env: dev?.env});
    const child = spawn(sh.file, sh.args, {
      cwd: opts.cwd,
      env: {...process.env, ...dev?.env, ...this.extraEnv?.(), ...this.vault?.env(), FORCE_COLOR: '0', CI: process.env.CI ?? '1', PAGER: 'cat', GIT_PAGER: 'cat'},
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

  /**
   * A command in a pseudo-terminal. Its environment looks like a person's terminal (no CI=1, which
   * makes tools skip the very prompts this is for). Output goes to the same bounded lines as any
   * command, plus the last RAW_KEEP bytes as they came, to repaint the screen when the user takes
   * over. When it goes quiet looking like a prompt, `waiting` is set and `input` emitted.
   */
  private startTty(shell: Shell, shellCmd: {file: string; args: string[]}, opts: {cwd: string; background: boolean; timeoutMs?: number; maxMs?: number; env?: Record<string, string>}): {shell: Shell; done: Promise<Shell>} {
    shell.tty = true;
    // PowerShell's -NonInteractive makes Read-Host fail: the point here is to be interactive.
    const sh = {...shellCmd, args: shellCmd.args.filter((a) => a !== '-NonInteractive')};
    const {CI: _ci, FORCE_COLOR: _fc, NO_COLOR: _nc, ...base} = process.env;
    const env = {...base, ...opts.env, ...this.extraEnv?.(), ...this.vault?.env(), TERM: 'xterm-256color', PAGER: 'cat', GIT_PAGER: 'cat'} as Record<string, string>;
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const term: Term = {write: () => {}, resize: () => {}, raw: '', alt: false};
    this.terms.set(shell.id, term);
    let resolveDone!: (s: Shell) => void;
    const done = new Promise<Shell>((r) => (resolveDone = r));
    const wanted = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const timeout = opts.background ? undefined : opts.maxMs ? Math.min(opts.maxMs, wanted) : wanted;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, err?: string) => {
      if (shell.endedAt) return;
      clearTimeout(timer);
      clearTimeout(term.quietTimer);
      this.flushPartial(shell);
      if (err) shell.lines.push(`[failed to start: ${err}]`);
      if (shell.status === 'running') shell.status = 'exited';
      shell.waiting = false;
      shell.exitCode = code;
      shell.endedAt = Date.now();
      this.procs.delete(shell.id);
      this.terms.delete(shell.id);
      this.trimFinished(shell);
      this.emit('change', shell);
      resolveDone(shell);
    };
    const onData = (d: string) => {
      term.raw = (term.raw + d).slice(-RAW_KEEP);
      // Full-screen programs switch to the alternate screen (vim, less, htop, fzf…).
      const alt = d.lastIndexOf('\x1b[?1049h'), main = d.lastIndexOf('\x1b[?1049l');
      if (alt >= 0 || main >= 0) term.alt = alt > main;
      this.emit('data', shell, d);
      this.append(shell, 'out', d);
      if (shell.waiting) {
        shell.waiting = false;
        this.emit('change', shell);
      }
      clearTimeout(term.quietTimer);
      term.quietTimer = setTimeout(() => this.checkWaiting(shell, term), QUIET_MS);
      term.quietTimer.unref?.();
    };
    void loadPty().then((pty) => {
      if (shell.status !== 'running') return finish(null);
      try {
        if (pty) {
          const p = pty.spawn(sh.file, sh.args, {name: 'xterm-256color', cols, rows, cwd: opts.cwd, env});
          shell.pid = p.pid;
          this.procs.set(shell.id, {pid: p.pid});
          term.write = (data) => p.write(data);
          term.resize = (c, r) => {
            try {
              p.resize(Math.max(20, c), Math.max(5, r));
            } catch {}
          };
          // Windows (ConPTY): killing the pid alone doesn't end the session; the pty has to close.
          term.kill = () => {
            try {
              p.kill();
            } catch {}
          };
          p.onData(onData);
          p.onExit(({exitCode}) => finish(exitCode));
        } else if (isWindows) {
          // No node-pty (and no `script`) on Windows: the command reads its answers from a plain pipe,
          // which is enough for most prompts, but programs that need a real console won't work.
          shell.lines.push('[no terminal is available on this system (node-pty did not load): it runs without one, answers go to its input]');
          const child = spawn(sh.file, sh.args, {cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
          shell.pid = child.pid;
          this.procs.set(shell.id, child);
          term.write = (data) => child.stdin?.write(data.replace(/\r(?!\n)/g, '\r\n'));
          child.stdout?.on('data', (b: Buffer) => onData(b.toString()));
          child.stderr?.on('data', (b: Buffer) => onData(b.toString()));
          child.on('error', (e) => finish(null, e.message));
          child.on('close', (code) => finish(code));
        } else {
          // No node-pty: `script` gives the command a terminal; we talk to it over pipes.
          // macOS script refuses a socket for stdin (Node's pipes are sockets): a FIFO via `< <(cat)` works.
          const [file, args] =
            process.platform === 'darwin'
              ? ['/bin/bash', ['-c', 'exec script -q /dev/null "$@" < <(cat)', 'rein', sh.file, ...sh.args]]
              : ['script', ['-qfec', [sh.file, ...sh.args].map(quote).join(' '), '/dev/null']];
          const child = spawn(file, args as string[], {cwd: opts.cwd, env: {...env, COLUMNS: String(cols), LINES: String(rows)}, stdio: ['pipe', 'pipe', 'pipe'], detached: true});
          shell.pid = child.pid;
          this.procs.set(shell.id, child);
          term.write = (data) => child.stdin?.write(data);
          child.stdout?.on('data', (b: Buffer) => onData(b.toString()));
          child.stderr?.on('data', (b: Buffer) => onData(b.toString()));
          child.on('error', (e) => finish(null, e.message));
          child.on('close', (code) => finish(code));
        }
      } catch (e) {
        finish(null, (e as Error).message);
      }
      this.emit('change', shell);
    });
    timer = timeout ? setTimeout(() => this.kill(shell.id, 'timeout'), timeout) : undefined;
    if (!opts.background) this.emit('foreground', shell);
    this.emit('change', shell);
    return {shell, done};
  }

  /** Quiet for QUIET_MS: is it waiting for the user? Without one (headless), stop it. */
  private checkWaiting(shell: Shell, term: Term): void {
    if (shell.status !== 'running') return;
    const partial = this.partial.get(`${shell.id}:out`) ?? '';
    const last = partial || shell.lines.at(-1) || '';
    if (!waitingForInput(last, partial, term.alt)) return;
    if (!this.interactiveUser) {
      this.flushPartial(shell);
      shell.lines.push('[it waited for input, and nobody can answer it here (no interactive user): stopped]');
      shell.noUser = true;
      this.kill(shell.id);
      return;
    }
    shell.waiting = true;
    this.emit('input', shell);
    this.emit('change', shell);
  }

  /** Keystrokes from the user to a terminal command. */
  write(id: number, data: string): boolean {
    const term = this.terms.get(id);
    if (!term) return false;
    term.write(data);
    return true;
  }

  /** The terminal's size changed (the user's window): full-screen programs redraw. */
  resize(id: number, cols: number, rows: number): void {
    this.terms.get(id)?.resize(cols, rows);
  }

  /** The recent raw output of a terminal command, to repaint its screen. */
  screen(id: number): string {
    return this.terms.get(id)?.raw ?? '';
  }

  kill(id: number, reason: 'killed' | 'timeout' = 'killed'): boolean {
    const child = this.procs.get(id);
    const shell = this.shells.get(id);
    if (!child || !shell || shell.status !== 'running') return false;
    shell.status = reason;
    killTree(child.pid, 'SIGTERM');
    if (isWindows) this.terms.get(id)?.kill?.();
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
  /** Everything still held: the first lines, then (after any gap) the last ones. */
  saved(shell: Shell): string {
    const gap = shell.dropped - (shell.head?.length ?? 0);
    if (!shell.dropped || !shell.head?.length) return shell.lines.join('\n');
    return `${shell.head.join('\n')}\n${gap > 0 ? `[… ${gap} lines not kept]\n` : ''}${shell.lines.slice(Math.max(0, -gap)).join('\n')}`;
  }

  tail(shell: Shell, n = 200): string {
    const lines = shell.lines.slice(-n);
    const skipped = shell.dropped + shell.lines.length - lines.length;
    return (skipped ? `[… ${skipped} earlier lines omitted]\n` : '') + lines.join('\n');
  }

  private append(shell: Shell, stream: 'out' | 'err', chunk: string): void {
    // Every command's output, from either path (previews look for the local URLs servers print).
    this.emit('output', shell, chunk);
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
    const shown = raw.includes('\r') ? raw.split('\r').filter(Boolean).at(-1) ?? '' : raw;
    const line = this.vault ? this.vault.mask(shown) : shown; // stored lines never hold a secret
    const kept = own(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line);
    shell.lines.push(kept);
    if ((shell.head ??= []).length < HEAD_LINES) shell.head.push(kept);
    if (shell.lines.length > MAX_LINES) {
      const drop = shell.lines.length - MAX_LINES;
      shell.lines.splice(0, drop);
      shell.dropped += drop;
    }
  }
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export function shellStatusText(s: Shell, now = Date.now()): string {
  const secs = Math.round(((s.endedAt ?? now) - s.startedAt) / 1000);
  const dur = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  if (s.status === 'running') return `running ${dur}`;
  if (s.status === 'timeout') return `timed out after ${dur}`;
  if (s.status === 'killed') return `killed after ${dur}`;
  return `exit ${s.exitCode ?? '?'} after ${dur}`;
}
