/**
 * Credentials and backend switches in the parent env would override the account's own login (a
 * shell with CLAUDE_CODE_USE_BEDROCK set would quietly turn every Claude account into Bedrock).
 * Each account gets only its own.
 */
const STRIP = {
    claude: [
        'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
        'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
        'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
    ],
    codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_HOME'],
};
/** What a Bedrock / Vertex account adds back (the CLI picks the backend from these). */
function backendEnv(account) {
    const c = account.apiConfig ?? {};
    if (account.api === 'bedrock')
        return { CLAUDE_CODE_USE_BEDROCK: '1', ...(c.region ? { AWS_REGION: c.region } : {}), ...(c.profile ? { AWS_PROFILE: c.profile } : {}) };
    if (account.api === 'vertex')
        return { CLAUDE_CODE_USE_VERTEX: '1', ...(c.projectId ? { ANTHROPIC_VERTEX_PROJECT_ID: c.projectId } : {}), ...(c.region ? { CLOUD_ML_REGION: c.region } : {}) };
    return {};
}
const HOME_VAR = {
    claude: 'CLAUDE_CONFIG_DIR',
    codex: 'CODEX_HOME',
};
/**
 * Environment for a child CLI process bound to one account.
 * The home var is only set for non-default dirs: `CLAUDE_CONFIG_DIR=~/.claude` explicitly
 * reads as logged out (different config path + keychain key), so default accounts inherit.
 */
export function accountEnv(account, base = process.env) {
    const env = { ...base };
    for (const key of STRIP[account.provider])
        delete env[key];
    if (account.home !== null)
        env[HOME_VAR[account.provider]] = account.home;
    return { ...env, ...backendEnv(account) };
}
