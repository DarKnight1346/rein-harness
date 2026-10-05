import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {ProviderId} from '../providers/types.js';

/**
 * Where Rein keeps things.
 *
 * One folder (the original layout) when `REIN_HOME` is set (tests never touch the real one), or
 * when `~/.rein` already exists (existing installs, and the default on macOS and Windows).
 * Otherwise, on Linux or wherever `XDG_*` variables are set, the XDG Base Directory spec:
 * what you write (config, settings, MCP servers, instructions, skills, agents) in
 * `$XDG_CONFIG_HOME/rein`, what Rein keeps (conversations, accounts, checkpoints, secrets) in
 * `$XDG_DATA_HOME/rein`, and its bookkeeping (usage, history, trust) in `$XDG_STATE_HOME/rein`.
 */
type Layout = {config: string; data: string; state: string};

function layout(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): Layout {
  if (env.REIN_HOME) return {config: env.REIN_HOME, data: env.REIN_HOME, state: path.join(env.REIN_HOME, 'state')};
  const legacy = path.join(home, '.rein');
  const xdgSet = !!(env.XDG_CONFIG_HOME || env.XDG_DATA_HOME || env.XDG_STATE_HOME);
  if (existsSync(legacy) || (platform !== 'linux' && !xdgSet)) return {config: legacy, data: legacy, state: path.join(legacy, 'state')};
  return {
    config: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'rein'),
    data: path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rein'),
    state: path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'rein'),
  };
}
export const layoutFor = layout;

/** Rein's data folder: conversations, accounts, checkpoints, exports, secrets, MCP sign-ins. */
export function reinHome(): string {
  return layout().data;
}

/** Where your own settings live: config.json, settings.json, mcp.json, AGENTS.md, skills/, agents/. */
export function reinConfigDir(): string {
  return layout().config;
}

export const paths = {
  config: () => path.join(reinConfigDir(), 'config.json'),
  accounts: () => path.join(reinHome(), 'accounts.json'),
  accountHome: (provider: ProviderId, id: string) => path.join(reinHome(), 'accounts', provider, id),
  state: () => layout().state,
  sessions: () => path.join(reinHome(), 'sessions'),
};
