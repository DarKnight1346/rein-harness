import {spawnSync} from 'node:child_process';
import {existsSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isWindows} from '../util/platform.js';
import {buildOutputDirs} from '../build/caches.js';

/**
 * OS-level sandbox for the agent's shell commands, on by default (/settings → Sandbox):
 *   write  — writes only inside the project, its working directories, the session scratchpad, temp
 *            folders and package-manager caches; the network is open.
 *   strict — the same, and no network except localhost.
 *   off    — no sandbox (approvals are the only guard).
 * macOS uses sandbox-exec (Seatbelt), Linux bubblewrap; Windows and Linux without bwrap run
 * unsandboxed (Rein says so once). Reads stay open, as in Claude Code and Codex. Inside the project,
 * files that could run code outside the sandbox later (git hooks and config, editor/agent settings)
 * stay read-only. Only the agent's commands are sandboxed: not `!` commands, hooks or MCP servers.
 */
export type SandboxMode = 'write' | 'strict' | 'off' | 'container';
export type SandboxSpec = {mode: SandboxMode; roots: string[]};

/** Files inside the project the sandboxed agent can't change (they'd run code unsandboxed later). */
const PROTECTED = ['.git/hooks', '.git/config', '.gitmodules', '.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.rein/settings.json', '.rein/settings.local.json', '.vscode', '.idea'];
/** Package-manager caches under home: writable so installs work (only the ones that exist). */
const CACHES = ['.npm', '.cache', 'Library/Caches', '.cargo', '.rustup', 'go/pkg', '.gradle', '.m2', '.bun', '.pnpm-store', 'Library/pnpm', '.local/share/pnpm', '.yarn', '.deno', '.pub-cache', '.nuget/packages', '.local/share/virtualenvs'];

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

let backend: 'seatbelt' | 'bwrap' | null | undefined;
/** Which mechanism this machine has (checked once). */
export function sandboxBackend(): 'seatbelt' | 'bwrap' | null {
  if (backend !== undefined) return backend;
  if (process.env.REIN_SANDBOX_BACKEND === 'none') return (backend = null);
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) return (backend = 'seatbelt');
  if (process.platform === 'linux') {
    // bwrap can be installed but unusable (user namespaces disabled): try it once.
    const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], {stdio: 'ignore', timeout: 5000});
    if (probe.status === 0) return (backend = 'bwrap');
  }
  return (backend = null);
}

/** Every path the sandboxed command may write to (real paths; only ones that exist where it matters). */
export function writablePaths(roots: string[]): string[] {
  const home = os.homedir();
  const tmp = [os.tmpdir(), '/tmp', process.env.TMPDIR].filter((p): p is string => !!p);
  const caches = CACHES.map((c) => path.join(home, c)).filter((p) => existsSync(p));
  return [...new Set([...roots, ...tmp, ...caches, ...buildOutputDirs()].map(real))]; // + Bazel's output base on macOS
}

const sb = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The Seatbelt profile: allow by default, deny writes outside the writable paths and to protected files. */
export function seatbeltProfile(spec: SandboxSpec): string {
  const writable = writablePaths(spec.roots);
  const protectedPaths = spec.roots.flatMap((r) => PROTECTED.map((p) => path.join(real(r), p)));
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (require-not (require-any ${[
      ...writable.map((p) => `(subpath ${sb(p)})`),
      ...['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/dtracehelper', '/dev/ptmx'].map((p) => `(literal ${sb(p)})`),
      '(regex #"^/dev/ttys")',
      '(regex #"^/dev/fd/")',
    ].join(' ')})))`,
    `(deny file-write* ${protectedPaths.map((p) => `(subpath ${sb(p)})`).join(' ')})`,
    ...(spec.mode === 'strict' ? ['(deny network-outbound (require-not (remote ip "localhost:*")))', '(allow network-outbound (remote unix-socket))'] : []),
  ].join('\n');
}

/** bubblewrap arguments: read-only root, the writable paths bound read-write, protected files back to read-only. */
export function bwrapArgs(spec: SandboxSpec): string[] {
  const writable = writablePaths(spec.roots).filter((p) => existsSync(p));
  const protectedPaths = spec.roots.flatMap((r) => PROTECTED.map((p) => path.join(real(r), p))).filter((p) => existsSync(p));
  return [
    '--new-session',
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    ...writable.flatMap((p) => ['--bind', p, p]),
    ...protectedPaths.flatMap((p) => ['--ro-bind', p, p]),
    ...(spec.mode === 'strict' ? ['--unshare-net'] : []),
  ];
}

/** Wrap a shell invocation in the sandbox; undefined = run as is (off, or no mechanism here). */
export function wrap(sh: {file: string; args: string[]}, spec: SandboxSpec | undefined): {file: string; args: string[]} | undefined {
  if (!spec || spec.mode === 'off' || isWindows) return undefined;
  const b = sandboxBackend();
  if (b === 'seatbelt') return {file: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(spec), sh.file, ...sh.args]};
  if (b === 'bwrap') return {file: 'bwrap', args: [...bwrapArgs(spec), '--', sh.file, ...sh.args]};
  return undefined;
}

/** A failed sandboxed command whose output looks like a sandbox denial: a note for the model. */
export function denialNote(output: string, spec: SandboxSpec): string | undefined {
  const write = /Operation not permitted|Read-only file system|EPERM|EROFS/i.test(output);
  const net = spec.mode === 'strict' && /Could not resolve host|Couldn't connect|Network is unreachable|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(output);
  if (!write && !net) return undefined;
  return `<sandbox_note>This command ran in Rein's sandbox: writes are limited to the project, its working directories, the session scratchpad, temp folders and package caches${spec.mode === 'strict' ? ', and there is no network except localhost' : ''}; git hooks/config and agent/editor settings in the project are read-only. The failure may be the sandbox. Write elsewhere inside the project or scratchpad if you can; if the command really must run outside the sandbox, call shell again with unsandboxed: true (the user is always asked).</sandbox_note>`;
}
