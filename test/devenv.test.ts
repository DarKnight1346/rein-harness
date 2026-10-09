import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {describeDevEnv, detectDevEnv, DevEnv, envDelta, type Runner} from '../src/env/devenv.js';
import {ShellManager} from '../src/tools/shells.js';

const repo = (files: string[]) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-env-')));
  for (const f of files) {
    mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
    writeFileSync(path.join(root, f), '{}');
  }
  return root;
};

describe('environment bootstrap', () => {
  it('finds the repo’s environment and keeps only the variables that differ', () => {
    expect([detectDevEnv(repo(['.devcontainer/devcontainer.json', 'flake.nix'])), detectDevEnv(repo(['flake.nix'])), detectDevEnv(repo(['shell.nix'])), detectDevEnv(repo(['devbox.json'])), detectDevEnv(repo([]))]).toEqual(['devcontainer', 'nix-flake', 'nix-shell', 'devbox', undefined]);
    expect(envDelta('PATH=/nix/store/go/bin:/usr/bin\0GOROOT=/nix/store/go\0HOME=/home/x\0SHLVL=2\0SAME=1\0', {PATH: '/usr/bin', SAME: '1', HOME: '/h'})).toEqual({PATH: '/nix/store/go/bin:/usr/bin', GOROOT: '/nix/store/go'});
  });

  it('captures a Nix shell once and adds its variables to commands', async () => {
    const root = repo(['flake.nix']);
    const calls: string[] = [];
    const runner: Runner = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), {code: 0, stdout: 'REIN_DEV_PROBE=from-nix\0', stderr: ''});
    const env = new DevEnv(root, () => 'auto', runner);
    expect(describeDevEnv(env.current())).toMatch(/Nix shell, starts with the agent's first command/);
    await env.ready();
    await env.ready();
    expect(calls).toEqual(['nix develop --command env -0']);
    expect(env.apply('go test ./...', path.join(root, 'pkg'))).toEqual({command: 'go test ./...', env: {REIN_DEV_PROBE: 'from-nix'}});
    if (process.platform === 'win32') return;
    const shells = new ShellManager();
    shells.devEnv = env;
    const {done} = shells.start('echo "$REIN_DEV_PROBE"', {cwd: root, background: false});
    expect(shells.tail(await done)).toContain('from-nix');
  });

  it('runs commands inside the dev container, from the matching folder', async () => {
    const root = repo(['.devcontainer/devcontainer.json']);
    const runner: Runner = async (_c, args) => (args[0] === 'up' ? {code: 0, stdout: 'starting\n{"outcome":"success","containerId":"abc","remoteWorkspaceFolder":"/workspaces/shop"}\n', stderr: ''} : {code: 0, stdout: '0.71.0', stderr: ''});
    const env = new DevEnv(root, () => 'devcontainer', runner);
    await env.ready();
    expect(describeDevEnv(env.current())).toBe('Dev environment: dev container, ready (container at /workspaces/shop).');
    expect(env.apply('npm test', path.join(root, 'api'))).toEqual({command: `devcontainer exec --workspace-folder '${root}' sh -c 'cd '\\''/workspaces/shop/api'\\'' && npm test'`, container: true});
    expect(env.apply('npm test', os.tmpdir())).toBeUndefined(); // outside the project (a worktree): on the host
  });

  it('falls back to the host, saying why, when the tool is missing or off', async () => {
    const logs: string[] = [];
    const env = new DevEnv(repo(['.devcontainer.json']), () => 'auto', async () => ({code: 127, stdout: '', stderr: 'spawn devcontainer ENOENT'}), (t) => logs.push(t));
    await env.ready();
    expect(env.apply('ls', os.tmpdir())).toBeUndefined();
    expect(logs).toEqual(["Dev environment: the devcontainer CLI isn't installed (npm install -g @devcontainers/cli). Commands run on this machine instead."]);
    expect(new DevEnv(repo(['flake.nix']), () => 'off').current()).toEqual({state: 'off'});
    expect(new DevEnv(repo([]), () => 'auto').current()).toEqual({state: 'none'});
  });
});
