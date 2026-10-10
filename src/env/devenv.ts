import {existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {run} from '../util/proc.js';

/**
 * Environment bootstrap (config `devEnvironment`): the agent's shell commands run in the repo's own
 * development environment instead of whatever is installed on the host.
 *
 * - Nix (`flake.nix`, `shell.nix`) and devbox (`devbox.json`): the environment is captured once
 *   (`nix develop --command env -0`) and its variables (PATH, compilers, SDKs…) are added to every
 *   command, which still runs on the host, in Rein's sandbox.
 * - Dev containers (`.devcontainer/devcontainer.json`): `devcontainer up` starts it once, then each
 *   command runs inside with `devcontainer exec`. The container is the isolation there, so the OS
 *   sandbox isn't applied on top.
 *
 * When the tool isn't installed (or fails), commands run on the host as before, and /env says why.
 */
export type DevKind = 'devcontainer' | 'nix-flake' | 'nix-shell' | 'devbox';
export type DevMode = 'off' | 'auto' | 'devcontainer' | 'nix' | 'devbox';
export type DevStatus = {kind?: DevKind; state: 'off' | 'none' | 'idle' | 'starting' | 'ready' | 'unavailable'; detail?: string};

export function detectDevEnv(root: string): DevKind | undefined {
  const has = (f: string) => existsSync(path.join(root, f));
  if (has('.devcontainer/devcontainer.json') || has('.devcontainer.json')) return 'devcontainer';
  if (has('flake.nix')) return 'nix-flake';
  if (has('shell.nix') || has('default.nix')) return 'nix-shell';
  if (has('devbox.json')) return 'devbox';
  return undefined;
}

/** Variables that describe the capturing shell, not the environment. */
const VOLATILE = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'TERM_PROGRAM', 'TERM_SESSION_ID', 'COLUMNS', 'LINES', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'NIX_BUILD_TOP', 'NIX_LOG_FD', 'IN_NIX_SHELL', 'out', 'dontAddDisableDepTrack']);

/** `env -0` output → the variables that differ from `base`. */
export function envDelta(env0: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of env0.split('\0')) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    const k = entry.slice(0, i);
    const v = entry.slice(i + 1);
    if (!VOLATILE.has(k) && base[k] !== v) out[k] = v;
  }
  return out;
}

export type Runner = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<{code: number; stdout: string; stderr: string}>;
const defaultRunner: Runner = async (cmd, args, cwd, timeoutMs) => {
  const r = await run(cmd, args, {cwd, timeoutMs}).catch((err) => ({code: 127, stdout: '', stderr: (err as Error).message}));
  return {code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr};
};

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class DevEnv {
  private status: DevStatus = {state: 'off'};
  private env: Record<string, string> | undefined;
  private workspace: string | undefined;
  private starting: Promise<void> | undefined;
  private captured = 0;

  constructor(
    private readonly root: string,
    private readonly mode: () => DevMode,
    private readonly runner: Runner = defaultRunner,
    private readonly log: (text: string) => void = () => {},
  ) {}

  private kind(): DevKind | undefined {
    const m = this.mode();
    if (m === 'off') return undefined;
    const found = detectDevEnv(this.root);
    if (m === 'auto') return found;
    if (m === 'devcontainer') return found === 'devcontainer' ? found : undefined;
    if (m === 'nix') return found === 'nix-flake' || found === 'nix-shell' ? found : existsSync(path.join(this.root, 'flake.nix')) ? 'nix-flake' : undefined;
    return existsSync(path.join(this.root, 'devbox.json')) ? 'devbox' : undefined;
  }

  current(): DevStatus {
    if (this.mode() === 'off') return {state: 'off'};
    const kind = this.kind();
    if (!kind) return {state: 'none'};
    return this.status.kind === kind ? this.status : {kind, state: 'idle'};
  }

  /** Start or capture the environment, once (again when the Nix lock file changes). Never throws. */
  ready(): Promise<void> {
    const kind = this.kind();
    if (!kind) return Promise.resolve();
    const lock = path.join(this.root, kind === 'devbox' ? 'devbox.lock' : 'flake.lock');
    const stale = kind !== 'devcontainer' && this.status.state === 'ready' && existsSync(lock) && statSync(lock).mtimeMs > this.captured;
    if (this.status.kind === kind && (this.status.state === 'ready' || this.status.state === 'unavailable') && !stale) return Promise.resolve();
    return (this.starting ??= this.start(kind).finally(() => (this.starting = undefined)));
  }

  private async start(kind: DevKind): Promise<void> {
    this.status = {kind, state: 'starting'};
    const fail = (detail: string) => {
      this.status = {kind, state: 'unavailable', detail};
      this.log(`Dev environment: ${detail}. Commands run on this machine instead.`);
    };
    if (kind === 'devcontainer') {
      const v = await this.runner('devcontainer', ['--version'], this.root, 20_000);
      if (v.code !== 0) return fail("the devcontainer CLI isn't installed (npm install -g @devcontainers/cli)");
      this.log('Dev environment: starting the dev container (devcontainer up)…');
      const up = await this.runner('devcontainer', ['up', '--workspace-folder', this.root], this.root, 20 * 60_000);
      const result = up.stdout.trim().split('\n').reverse().map((l) => {
        try {
          return JSON.parse(l) as {outcome?: string; remoteWorkspaceFolder?: string; message?: string};
        } catch {
          return undefined;
        }
      }).find((x) => x?.outcome);
      if (up.code !== 0 || result?.outcome !== 'success') return fail(`devcontainer up failed: ${(result?.message ?? up.stderr.trim().split('\n').pop() ?? 'is Docker running?').slice(0, 200)}`);
      this.workspace = result.remoteWorkspaceFolder;
      this.status = {kind, state: 'ready', detail: `container at ${this.workspace}`};
      this.log(`Dev environment: commands now run in the dev container (${this.workspace}).`);
      return;
    }
    const [cmd, args] = kind === 'nix-flake' ? ['nix', ['develop', '--command', 'env', '-0']] : kind === 'nix-shell' ? ['nix-shell', ['--run', 'env -0']] : ['devbox', ['run', '--', 'env', '-0']];
    this.log(`Dev environment: loading ${kind === 'devbox' ? 'the devbox shell' : 'the Nix shell'} (${cmd} ${(args as string[]).join(' ')})…`);
    const r = await this.runner(cmd as string, args as string[], this.root, 20 * 60_000);
    if (r.code === 127 || /ENOENT|not found/i.test(r.stderr) && r.code !== 0) return fail(`${cmd} isn't installed`);
    if (r.code !== 0) return fail(`${cmd} failed: ${r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? `exit ${r.code}`}`);
    this.env = envDelta(r.stdout);
    this.captured = Date.now();
    this.status = {kind, state: 'ready', detail: `${Object.keys(this.env).length} variables`};
    this.log(`Dev environment: commands now run with the ${kind === 'devbox' ? 'devbox' : 'Nix'} shell's environment (${Object.keys(this.env).length} variables).`);
  }

  /** How to run `command` in `cwd`: inside the container, or on the host with the captured variables. */
  apply(command: string, cwd: string): {command: string; env?: Record<string, string>; container?: true} | undefined {
    if (this.status.state !== 'ready') return undefined;
    const rel = path.relative(this.root, cwd);
    const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
    if (this.status.kind === 'devcontainer') {
      if (!inside || !this.workspace) return undefined; // a worktree or another folder isn't in the container
      const dir = rel ? `${this.workspace.replace(/\/$/, '')}/${rel.split(path.sep).join('/')}` : this.workspace;
      return {command: `devcontainer exec --workspace-folder ${quote(this.root)} sh -c ${quote(`cd ${quote(dir)} && ${command}`)}`, container: true};
    }
    return this.env ? {command, env: this.env} : undefined;
  }
}

export function describeDevEnv(s: DevStatus): string {
  if (s.state === 'off') return "Dev environment: off (commands run on this machine).";
  if (s.state === 'none') return "Dev environment: this repo has no dev container, flake.nix, shell.nix or devbox.json, so commands run on this machine.";
  const name = s.kind === 'devcontainer' ? 'dev container' : s.kind === 'devbox' ? 'devbox shell' : 'Nix shell';
  if (s.state === 'ready') return `Dev environment: ${name}, ready (${s.detail}).`;
  if (s.state === 'starting') return `Dev environment: ${name}, starting…`;
  if (s.state === 'idle') return `Dev environment: ${name}, starts with the agent's first command (/env up starts it now).`;
  return `Dev environment: ${name} unavailable: ${s.detail}. Commands run on this machine.`;
}
