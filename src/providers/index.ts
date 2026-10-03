import {claudeAdapter} from './claude/adapter.js';
import {codexAdapter} from './codex/adapter.js';
import type {Account, ProviderAdapter, ProviderId} from './types.js';

export const adapters: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/** Auth-only view, used by the account service. */
export const auth = adapters;

/** The CLIs' default login dirs, used for first-run import. Env var left unset (see env.ts). */
export function defaultAccount(provider: ProviderId): Account {
  return {id: `${provider}-default`, provider, home: null, imported: true, label: 'imported'};
}
