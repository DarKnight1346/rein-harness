import {adapters} from '../providers/index.js';
import {codexCompat, type CompatReport} from '../providers/codex/compat.js';
import {readModelsCache} from '../providers/codex/catalog.js';
import type {Account, ModelInfo, ModelRef} from '../providers/types.js';
import {refKey} from '../providers/types.js';
import {loadAccounts} from '../store/accounts.js';
import {readJson, writeJson} from '../store/json.js';
import {paths} from '../store/paths.js';
import path from 'node:path';

const windowsFile = () => path.join(paths.state(), 'context-windows.json');
import {balanceScore, headroom, usageStore} from '../store/usage.js';

/** Score points per live session already on an account. */
export const BUSY_PENALTY = 15;

export type CatalogModel = ModelInfo & {accountIds: string[]};
export const toRef = (m: ModelInfo): ModelRef => ({provider: m.provider, model: m.id});

/**
 * All models offered across registered accounts. Claude models are static; Codex models come
 * from each account's `model/list` (plans differ), so a model maps to the accounts offering it.
 */
export class ModelCatalog {
  private models = new Map<string, CatalogModel>();
  private accounts: Account[] = [];
  /** False until the first refresh completes (status bar shows '…' meanwhile). */
  loaded = false;
  /** Accounts that failed auth at runtime; skipped until re-login. */
  readonly authFailed = new Set<string>();
  /** The installed codex's compatibility check (see providers/codex/compat.ts); ok false = Codex off. */
  codexCompat: CompatReport | undefined;

  async refresh(): Promise<void> {
    if (!this.windowsLoaded) {
      this.windowsLoaded = true;
      const saved = await readJson<Record<string, number>>(windowsFile(), {}).catch(() => ({}));
      for (const [k, v] of Object.entries(saved)) if (!this.learnedWindows.has(k)) this.learnedWindows.set(k, v);
    }
    const {accounts} = await loadAccounts();
    this.accounts = accounts;
    this.authFailed.clear(); // refresh follows /login changes: give re-authenticated accounts a new chance
    const next = new Map<string, CatalogModel>();
    // A codex whose app-server protocol lacks what Rein needs is switched off: Claude keeps working.
    const codexAccounts = accounts.filter((a) => a.provider === 'codex');
    if (codexAccounts.length) {
      const compat = await codexCompat(async () => (await readModelsCache(codexAccounts[0]!))?.models).catch(() => undefined);
      this.codexCompat = compat?.report;
    }
    const codexOff = this.codexCompat?.ok === false;
    await Promise.all(
      accounts.map(async (account) => {
        if (codexOff && account.provider === 'codex') return;
        let list: ModelInfo[] = [];
        try {
          list = await adapters[account.provider].listModels(account);
        } catch {
          return;
        }
        for (const m of list) {
          const key = refKey({provider: m.provider, model: m.id});
          const existing = next.get(key);
          if (existing) existing.accountIds.push(account.id);
          else next.set(key, {...m, contextWindow: this.learnedWindows.get(key) ?? m.contextWindow, accountIds: [account.id]});
        }
      }),
    );
    this.models = next;
    this.loaded = true;
  }

  /** Provider-reported context window (from a request's usage) — remembered across restarts. */
  learnContextWindow(ref: ModelRef, tokens: number): void {
    if (tokens <= 0) return;
    const changed = this.learnedWindows.get(refKey(ref)) !== tokens;
    this.learnedWindows.set(refKey(ref), tokens);
    if (changed) void writeJson(windowsFile(), Object.fromEntries(this.learnedWindows)).catch(() => {});
    const m = this.models.get(refKey(ref));
    if (m) m.contextWindow = tokens;
  }
  private learnedWindows = new Map<string, number>();
  private windowsLoaded = false;

  all(): CatalogModel[] {
    return [...this.models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.tier - b.tier);
  }

  get(ref: ModelRef): CatalogModel | undefined {
    return this.models.get(refKey(ref));
  }

  /** Registered accounts in their saved order (numbering for "Claude Account 1"). */
  accountList(): Account[] {
    return this.accounts;
  }

  account(id: string): Account | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  accountsFor(ref: ModelRef): Account[] {
    const ids = this.get(ref)?.accountIds ?? [];
    return this.accounts.filter((a) => ids.includes(a.id));
  }

  /** Accounts being removed: never picked again; their live sessions finish and are then closed. */
  readonly retired = new Set<string>();

  /** Live sessions per account (main chat, subagents): spreads parallel work across accounts. */
  readonly busy = new Map<string, number>();

  /** Count a live session against its account until it's closed. */
  track<S extends {accountId: string; close(): void}>(session: S): S {
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
  score(accountId: string): number {
    return balanceScore(usageStore.get(accountId)) - BUSY_PENALTY * (this.busy.get(accountId) ?? 0);
  }

  /** Healthy = not cooling down, not auth-failed, under the used-% ceiling. Best to use first. */
  healthyAccounts(ref: ModelRef, maxUsedPct: number, exclude: ReadonlySet<string> = new Set()): Account[] {
    return this.accountsFor(ref)
      .filter((a) => !exclude.has(a.id) && !this.retired.has(a.id) && !this.authFailed.has(a.id) && !usageStore.cooldownUntil(a.id))
      .filter((a) => headroom(usageStore.get(a.id)) > 100 - maxUsedPct)
      .sort((a, b) => this.score(b.id) - this.score(a.id));
  }

  /** Models with at least one healthy account. */
  available(maxUsedPct: number, exclude: ReadonlySet<string> = new Set()): CatalogModel[] {
    return this.all().filter((m) => this.healthyAccounts(toRef(m), maxUsedPct, exclude).length > 0);
  }

  /** "Cheapest available": lowest cost tier with a healthy account; ties → most headroom. */
  cheapest(maxUsedPct: number, exclude: ReadonlySet<string> = new Set()): CatalogModel | undefined {
    const best = (m: CatalogModel) => Math.max(...this.healthyAccounts(toRef(m), maxUsedPct, exclude).map((a) => this.score(a.id)));
    return this.available(maxUsedPct, exclude).sort((a, b) => a.tier - b.tier || best(b) - best(a))[0];
  }

  /** Provider default: Claude Sonnet if any Claude account, else Codex's flagged default. */
  defaultModel(maxUsedPct: number): CatalogModel | undefined {
    const avail = this.available(maxUsedPct);
    return avail.find((m) => m.provider === 'claude' && m.isDefault) ?? avail.find((m) => m.isDefault) ?? avail[0];
  }
}

export const catalog = new ModelCatalog();
