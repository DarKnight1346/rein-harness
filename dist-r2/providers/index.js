import { claudeAdapter } from './claude/adapter.js';
import { codexAdapter } from './codex/adapter.js';
export const adapters = {
    claude: claudeAdapter,
    codex: codexAdapter,
};
/** Auth-only view, used by the account service. */
export const auth = adapters;
/** The CLIs' default login dirs, used for first-run import. Env var left unset (see env.ts). */
export function defaultAccount(provider) {
    return { id: `${provider}-default`, provider, home: null, imported: true, label: 'imported' };
}
