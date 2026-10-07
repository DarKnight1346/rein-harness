import { adapters } from '../providers/index.js';
import { codexCompat } from '../providers/codex/compat.js';
import { readModelsCache } from '../providers/codex/catalog.js';
import { refKey } from '../providers/types.js';
import { loadAccounts } from '../store/accounts.js';
import { readJson, writeJson } from '../store/json.js';
import { paths } from '../store/paths.js';
import path from 'node:path';
const windowsFile = () => path.join(paths.state(), 'context-windows.json');
import { balanceScore, headroom, usageStore } from '../store/usage.js';
/** Score points per live session already on an account. */
export const BUSY_PENALTY = 15;
export const toRef = (m) => ({ provider: m.provider, model: m.id });
/**
 * All models offered across registered accounts. Claude models are static; Codex models come
 * from each account's `model/list` (plans differ), so a model maps to the accounts offering it.
 */
export class ModelCatalog {
    models = new Map();
    accounts = [];
    /** False until the first refresh completes (status bar shows '…' meanwhile). */
    loaded = false;
    /** Accounts that failed auth at runtime; skipped until re-login. */
    authFailed = new Set();
    /**
     * API accounts (pay per use): 'fallback' (default) = only when no subscription account can serve
     * the model; 'always' = alongside subscriptions (still after them). Set from config.apiAccounts.
     */
    apiAccounts = 'fallback';
    /** The installed codex's compatibility check (see providers/codex/compat.ts); ok false = Codex off. */
    codexCompat;
    async refresh() {
        if (!this.windowsLoaded) {
            this.windowsLoaded = true;
            const saved = await readJson(windowsFile(), {}).catch(() => ({}));
            for (const [k, v] of Object.entries(saved))
                if (!this.learnedWindows.has(k))
                    this.learnedWindows.set(k, v);
        }
        const { accounts } = await loadAccounts();
        this.accounts = accounts;
        this.authFailed.clear(); // refresh follows /login changes: give re-authenticated accounts a new chance
        const next = new Map();
        // A codex whose app-server protocol lacks what Rein needs is switched off: Claude keeps working.
        const codexAccounts = accounts.filter((a) => a.provider === 'codex');
        if (codexAccounts.length) {
            const compat = await codexCompat(async () => (await readModelsCache(codexAccounts[0]))?.models).catch(() => undefined);
            this.codexCompat = compat?.report;
        }
        const codexOff = this.codexCompat?.ok === false;
        await Promise.all(accounts.map(async (account) => {
            if (codexOff && account.provider === 'codex')
                return;
            let list = [];
            try {
                list = await adapters[account.provider].listModels(account);
            }
            catch {
                return;
            }
            for (const m of list) {
                const key = refKey({ provider: m.provider, model: m.id });
                const existing = next.get(key);
                if (existing)
                    existing.accountIds.push(account.id);
                else
                    next.set(key, { ...m, contextWindow: this.learnedWindows.get(key) ?? m.contextWindow, accountIds: [account.id] });
            }
        }));
        this.models = next;
        this.loaded = true;
    }
    /** Provider-reported context window (from a request's usage) — remembered across restarts. */
    learnContextWindow(ref, tokens) {
        if (tokens <= 0)
            return;
        const changed = this.learnedWindows.get(refKey(ref)) !== tokens;
        this.learnedWindows.set(refKey(ref), tokens);
        if (changed)
            void writeJson(windowsFile(), Object.fromEntries(this.learnedWindows)).catch(() => { });
        const m = this.models.get(refKey(ref));
        if (m)
            m.contextWindow = tokens;
    }
    learnedWindows = new Map();
    windowsLoaded = false;
    all() {
        return [...this.models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.tier - b.tier);
    }
    get(ref) {
        return this.models.get(refKey(ref));
    }
    /** Registered accounts in their saved order (numbering for "Claude Account 1"). */
    accountList() {
        return this.accounts;
    }
    account(id) {
        return this.accounts.find((a) => a.id === id);
    }
    accountsFor(ref) {
        const ids = this.get(ref)?.accountIds ?? [];
        return this.accounts.filter((a) => ids.includes(a.id));
    }
    /** Accounts being removed: never picked again; their live sessions finish and are then closed. */
    retired = new Set();
    /** Live sessions per account (main chat, subagents): spreads parallel work across accounts. */
    busy = new Map();
    /** Count a live session against its account until it's closed. */
    track(session) {
        const id = session.accountId;
        this.busy.set(id, (this.busy.get(id) ?? 0) + 1);
        const close = session.close.bind(session);
        let open = true;
        session.close = () => {
            if (open) {
                open = false;
                this.busy.set(id, Math.max(0, (this.busy.get(id) ?? 1) - 1));
            }
            close();
        };
        return session;
    }
    /** Balance score minus a penalty per live session on the account (see balanceScore). */
    score(accountId) {
        return balanceScore(usageStore.get(accountId)) - BUSY_PENALTY * (this.busy.get(accountId) ?? 0);
    }
    /** Healthy = not cooling down, not auth-failed, under the used-% ceiling. Best to use first. */
    healthyAccounts(ref, maxUsedPct, exclude = new Set()) {
        const healthy = this.accountsFor(ref)
            .filter((a) => !exclude.has(a.id) && !this.retired.has(a.id) && !this.authFailed.has(a.id) && !usageStore.cooldownUntil(a.id))
            .filter((a) => headroom(usageStore.get(a.id)) > 100 - maxUsedPct)
            .sort((a, b) => this.score(b.id) - this.score(a.id));
        // Subscriptions first (already paid for); pay-per-use API accounts after them, or only as a
        // fallback when no subscription can serve this model.
        const subs = healthy.filter((a) => !a.api);
        const api = healthy.filter((a) => a.api);
        return this.apiAccounts === 'always' || !subs.length ? [...subs, ...api] : subs;
    }
    /** Models with at least one healthy account. */
    available(maxUsedPct, exclude = new Set()) {
        return this.all().filter((m) => this.healthyAccounts(toRef(m), maxUsedPct, exclude).length > 0);
    }
    /** "Cheapest available": lowest cost tier with a healthy account; ties → most headroom. */
    cheapest(maxUsedPct, exclude = new Set()) {
        const best = (m) => Math.max(...this.healthyAccounts(toRef(m), maxUsedPct, exclude).map((a) => this.score(a.id)));
        return this.available(maxUsedPct, exclude).sort((a, b) => a.tier - b.tier || best(b) - best(a))[0];
    }
    /** Provider default: Claude Sonnet if any Claude account, else Codex's flagged default. */
    defaultModel(maxUsedPct) {
        const avail = this.available(maxUsedPct);
        return avail.find((m) => m.provider === 'claude' && m.isDefault) ?? avail.find((m) => m.isDefault) ?? avail[0];
    }
}
export const catalog = new ModelCatalog();
