import { readJson, writeJson } from './json.js';
import { paths } from './paths.js';
export const DEFAULT_CONFIG = {
    version: 1,
    decisionModel: 'cheapest',
    compactionModel: 'cheapest',
    advisorModel: 'off',
    webModel: 'cheapest',
    subagentModel: 'auto',
    chatEffort: 'auto',
    subagentPriority: 'user',
    hidePersonalInfo: true,
    autoUpdate: true,
    additionalDirectories: [],
    loadBalancing: 'balanced',
    autoSwitchThreshold: 0.7,
    autoMinConfidence: 0.45,
    maxUsedPct: 98,
    autoCompactPct: 80,
    toolApproval: 'ask',
    shellMaxMinutes: 120,
    subagentLimit: 10,
    goalMaxRounds: 0,
    jevModel: 'jev-1.13.0',
    notifications: 'terminal',
    backgroundCheckMinutes: 60,
    sandbox: 'write',
    apiAccounts: 'fallback',
    collapsePastes: true,
    attribution: true,
    waitForLimits: true,
    steerShell: true,
    mcpSampling: 'ask',
    inlineImages: 'auto',
    rtl: 'auto',
    remoteHost: '127.0.0.1',
    remotePort: 7377,
    trackers: [],
    trackerPollMinutes: 2,
    notifyUrl: '',
    voiceModel: 'base.en-q5_1',
    lsp: 'auto',
    lspIdleMinutes: 10,
    worktrees: 'auto',
    experiments: [],
};
export async function loadConfig() {
    return { ...DEFAULT_CONFIG, ...(await readJson(paths.config(), {})) };
}
export async function saveConfig(config) {
    await writeJson(paths.config(), config);
}
export async function updateConfig(patch) {
    const next = { ...(await loadConfig()), ...patch };
    await saveConfig(next);
    return next;
}
