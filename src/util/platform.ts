import {spawn as nodeSpawn, spawnSync} from 'node:child_process';
import crossSpawn from 'cross-spawn';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isWindows = process.platform === 'win32';

/**
 * `spawn` for external CLIs (claude, codex, npm…): cross-spawn resolves Windows `.cmd`/`.bat`
 * shims and PATHEXT (npm-installed CLIs are `.cmd` files there); elsewhere it's plain spawn.
 * Same signature and types as node's.
 */
export const spawn = ((command: string, args?: readonly string[], options?: object) => {
  // A JS file as the command (test fakes, REIN_CLAUDE_BIN=…/fake.mjs) runs through node, so it
  // works on Windows too, where scripts aren't executable.
  if (/\.(mjs|cjs|js)$/i.test(command)) return crossSpawn(process.execPath, [command, ...(args ?? [])], options as any);
  return crossSpawn(command, (args ?? []) as string[], options as any);
}) as unknown as typeof nodeSpawn;

/** A local IPC endpoint: a unix socket, or a named pipe on Windows. */
export function ipcPath(name: string): string {
  return isWindows ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

let gitBash: string | null | undefined;

/**
 * Git Bash on Windows (what Claude Code uses there too): REIN_GIT_BASH_PATH /
 * CLAUDE_CODE_GIT_BASH_PATH, the default install locations, or `bash.exe` beside `git` on PATH.
 */
export function findGitBash(): string | undefined {
  if (gitBash !== undefined) return gitBash ?? undefined;
  const candidates = [
    process.env.REIN_GIT_BASH_PATH,
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((p): p is string => !!p);
  let found = candidates.find((p) => existsSync(p));
  if (!found) {
    const where = spawnSync('where', ['git'], {encoding: 'utf8'});
    const git = where.stdout?.split(/\r?\n/).find(Boolean);
    const bash = git && path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe');
    if (bash && existsSync(bash)) found = bash;
  }
  gitBash = found ?? null;
  return found;
}

/**
 * How to run a shell command line: $SHELL (or /bin/sh) -c on macOS/Linux; on Windows Git Bash -c
 * when installed (bash syntax, like Claude Code), else PowerShell.
 */
export function shellFor(command: string): {file: string; args: string[]; kind: 'posix' | 'powershell'} {
  if (!isWindows) return {file: process.env.SHELL || '/bin/sh', args: ['-c', command], kind: 'posix'};
  const bash = findGitBash();
  if (bash) return {file: bash, args: ['-c', command], kind: 'posix'};
  return {file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command], kind: 'powershell'};
}

/** Stop a process and everything it started: its process group, or taskkill /T on Windows. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  if (isWindows) {
    nodeSpawn('taskkill', ['/pid', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {stdio: 'ignore'}).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}
