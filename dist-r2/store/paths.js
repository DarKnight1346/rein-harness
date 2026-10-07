import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
function layout(env = process.env, home = os.homedir(), platform = process.platform) {
    if (env.REIN_HOME)
        return { config: env.REIN_HOME, data: env.REIN_HOME, state: path.join(env.REIN_HOME, 'state') };
    const legacy = path.join(home, '.rein');
    const xdgSet = !!(env.XDG_CONFIG_HOME || env.XDG_DATA_HOME || env.XDG_STATE_HOME);
    if (existsSync(legacy) || (platform !== 'linux' && !xdgSet))
        return { config: legacy, data: legacy, state: path.join(legacy, 'state') };
    return {
        config: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'rein'),
        data: path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rein'),
        state: path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'rein'),
    };
}
export const layoutFor = layout;
/** Rein's data folder: conversations, accounts, checkpoints, exports, secrets, MCP sign-ins. */
export function reinHome() {
    return layout().data;
}
/** Where your own settings live: config.json, settings.json, mcp.json, AGENTS.md, skills/, agents/. */
export function reinConfigDir() {
    return layout().config;
}
export const paths = {
    config: () => path.join(reinConfigDir(), 'config.json'),
    accounts: () => path.join(reinHome(), 'accounts.json'),
    accountHome: (provider, id) => path.join(reinHome(), 'accounts', provider, id),
    state: () => layout().state,
    sessions: () => path.join(reinHome(), 'sessions'),
};
