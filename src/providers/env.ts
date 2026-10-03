import type {Account} from './types.js';

/** Credentials in the parent env would override the account's own subscription login. */
const STRIP: Record<Account['provider'], string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_HOME'],
};

const HOME_VAR: Record<Account['provider'], string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * Environment for a child CLI process bound to one account.
 * The home var is only set for non-default dirs: `CLAUDE_CONFIG_DIR=~/.claude` explicitly
 * reads as logged out (different config path + keychain key), so default accounts inherit.
 */
export function accountEnv(account: Account, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = {...base};
  for (const key of STRIP[account.provider]) delete env[key];
  if (account.home !== null) env[HOME_VAR[account.provider]] = account.home;
  return env;
}
