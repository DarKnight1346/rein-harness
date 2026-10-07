import { parseRef, refKey } from '../providers/types.js';
import { runtime } from '../runtime.js';
import { catalog } from '../router/catalog.js';
import { defaultRef } from '../router/index.js';
import { estimateTokens, renderMessages } from '../session/transcript.js';
import { usageStore, windowLabel } from '../store/usage.js';
import { accountLabel, modelLabel } from './format.js';
/** Status line segments, in default order. */
export const STATUS_ITEMS = [
    { id: 'model', label: 'Model', description: 'Chat model (auto shows the routed model) · click: /model' },
    { id: 'account', label: 'Account', description: 'Account serving the conversation · click: /usage' },
    { id: 'usage', label: 'Usage', description: "That account's usage windows (5h / weekly / …)" },
    { id: 'context', label: 'Context', description: 'Context window fill % · click: /context' },
    { id: 'decider', label: 'Decision model', description: 'Jev or the LLM that routes auto mode' },
    { id: 'messages', label: 'Messages', description: 'Messages in this conversation' },
    { id: 'advisor', label: 'Advisor', description: 'Advisor model agents can consult (or off)' },
    { id: 'approvals', label: 'Approvals', description: 'File-change approval mode (ask / auto / bypass)' },
    { id: 'sidebarToggle', label: 'Sidebar button', description: '[≡] toggles the sidebar (fullscreen)' },
];
export const DEFAULT_STATUS = ['model', 'account', 'usage', 'context', 'sidebarToggle'];
/** Sidebar sections, in default order. */
export const SIDEBAR_ITEMS = [
    { id: 'agents', label: 'Agents', description: 'main + running subagents; click one to view and message it' },
    { id: 'accounts', label: 'Accounts', description: 'Every account with its usage bars' },
    { id: 'models', label: 'Chat model', description: 'Click a model to switch' },
    { id: 'context', label: 'Context', description: 'Context fill bar for the active model' },
    { id: 'routing', label: 'Auto routing', description: 'Last auto-routing decision and decider' },
    { id: 'session', label: 'Session', description: 'Message count, compact and accounts shortcuts' },
    { id: 'shortcuts', label: 'Shortcuts', description: 'Key and mouse cheatsheet' },
];
export const DEFAULT_SIDEBAR = ['agents', 'accounts', 'models', 'session'];
/** Configured ids in order, dropping unknown ones (e.g. from a newer/older config). */
export function enabledItems(kind, cfg) {
    const known = new Set((kind === 'status' ? STATUS_ITEMS : SIDEBAR_ITEMS).map((i) => i.id));
    const list = kind === 'status' ? (cfg.statusLine ?? DEFAULT_STATUS) : (cfg.sidebarSections ?? DEFAULT_SIDEBAR);
    return list.filter((id) => known.has(id));
}
/** Live values behind the status line (shared by the fullscreen top bar and the classic status bar). */
export function statusInfo(viewing) {
    const cfg = runtime.config;
    const engine = runtime.engine;
    const current = engine?.current;
    if (viewing)
        return subagentStatusInfo(viewing);
    const chosen = cfg.chatModel === 'auto' ? undefined : cfg.chatModel ? parseRef(cfg.chatModel) : defaultRef(cfg);
    const model = cfg.chatModel === 'auto' ? `auto${current ? ` · ${modelLabel(current.ref)}` : ''}` : chosen ? modelLabel(chosen) : '—';
    // Only show the live session's account if it still serves the selected model's provider.
    const sameProvider = !chosen || !current || chosen.provider === current.ref.provider;
    const account = current && sameProvider ? catalog.account(current.accountId) : undefined;
    const accountCount = new Set(catalog.all().flatMap((m) => m.accountIds)).size;
    const snap = account ? usageStore.get(account.id) : undefined;
    const usage = snap?.windows.map((w) => `${windowLabel(w.windowMins)} ${Math.round(w.usedPct)}%`).join(' · ') ?? '';
    const decider = cfg.decisionModel === 'jev' ? 'Jev' : cfg.decisionModel === 'cheapest' ? `cheapest${catalog.cheapest(cfg.maxUsedPct) ? ` (${catalog.cheapest(cfg.maxUsedPct).label})` : ''}` : modelLabel(parseRef(cfg.decisionModel) ?? { provider: 'claude', model: cfg.decisionModel });
    return {
        model,
        account: account ? accountLabel(account) : catalog.loaded ? `${accountCount} account${accountCount === 1 ? '' : 's'}` : '…',
        usage,
        context: contextPct(),
        decider,
        messages: engine?.transcript.messages.length ?? 0,
        approvals: cfg.toolApproval,
        advisor: cfg.advisorModel === 'off' ? 'off' : modelLabel(parseRef(cfg.advisorModel) ?? { provider: 'claude', model: cfg.advisorModel }),
    };
}
/** The status line while viewing a subagent: its model, account, usage and context. */
function subagentStatusInfo(a) {
    const cfg = runtime.config;
    const account = a.accountId ? catalog.account(a.accountId) : undefined;
    const snap = account ? usageStore.get(account.id) : undefined;
    const window = (a.ref && catalog.get(a.ref)?.contextWindow) || 200_000;
    const decider = cfg.decisionModel === 'jev' ? 'Jev' : cfg.decisionModel === 'cheapest' ? 'cheapest' : modelLabel(parseRef(cfg.decisionModel) ?? { provider: 'claude', model: cfg.decisionModel });
    return {
        model: a.modelLabel ?? (a.ref ? modelLabel(a.ref) : a.requested),
        account: account ? accountLabel(account) : '…',
        usage: snap?.windows.map((w) => `${windowLabel(w.windowMins)} ${Math.round(w.usedPct)}%`).join(' · ') ?? '',
        context: contextPct(a, window),
        decider,
        messages: a.events.filter((e) => e.kind === 'text' || e.kind === 'user').length + 1,
        approvals: cfg.toolApproval,
        advisor: cfg.advisorModel === 'off' ? 'off' : modelLabel(parseRef(cfg.advisorModel) ?? { provider: 'claude', model: cfg.advisorModel }),
    };
}
/** Rough context fill of the active (or configured) model: provider-measured if available. */
export function contextPct(viewing, subWindow) {
    if (viewing) {
        const window = subWindow ?? ((viewing.ref && catalog.get(viewing.ref)?.contextWindow) || 200_000);
        return Math.min(100, Math.round(((viewing.lastInput ?? 0) / window) * 100));
    }
    const engine = runtime.engine;
    if (!engine)
        return 0;
    const ref = engine.current?.ref ?? defaultRef(runtime.config);
    const window = (ref && catalog.get(ref)?.contextWindow) || 200_000;
    const t = engine.transcript;
    const used = engine.lastUsage && ref && refKey(engine.lastUsage.ref) === refKey(ref)
        ? engine.lastUsage.input
        : estimateTokens((t.summary?.text ?? '') + renderMessages(t.messages.slice(t.summary?.coversUpTo ?? 0)));
    return Math.min(100, Math.round((used / window) * 100));
}
