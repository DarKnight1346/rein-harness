import {adapters} from '../providers/index.js';
import type {Account, UsageSnapshot} from '../providers/types.js';
import {loadAccounts} from '../store/accounts.js';
import {getJevKey} from '../store/secrets.js';
import {usageStore} from '../store/usage.js';

/** Claude has no free usage endpoint: refresh (a tiny haiku ping) only when the cache is older than this. */
export const CLAUDE_STALE_MS = 10 * 60_000;

export type UsageRow = {
  account: Account;
  snapshot?: UsageSnapshot;
  cooldownUntil?: number;
  error?: string;
  refreshed: boolean;
};

export async function collectUsage(opts: {force: boolean}): Promise<{rows: UsageRow[]; jev: boolean}> {
  const {accounts} = await loadAccounts();
  const rows = await Promise.all(
    accounts.map(async (account): Promise<UsageRow> => {
      const adapter = adapters[account.provider];
      const cached = usageStore.get(account.id);
      try {
        let snapshot: UsageSnapshot | undefined;
        let refreshed = false;
        if (account.provider === 'codex') {
          snapshot = await adapter.readUsage(account); // free: account/rateLimits/read
          refreshed = true;
        } else if (opts.force || !cached || Date.now() - cached.at > CLAUDE_STALE_MS) {
          snapshot = await adapter.refreshUsage(account);
          refreshed = true;
        } else {
          snapshot = cached;
        }
        return {account, snapshot: snapshot ?? cached, refreshed, cooldownUntil: usageStore.cooldownUntil(account.id)};
      } catch (err) {
        return {account, snapshot: cached, refreshed: false, error: (err as Error).message, cooldownUntil: usageStore.cooldownUntil(account.id)};
      }
    }),
  );
  return {rows, jev: !!(await getJevKey())};
}

const CODEX_REFRESH_MS = 10 * 60_000;
/** Idle Claude accounts are pinged at most this often (a tiny haiku request) so balancing has data. */
const CLAUDE_IDLE_REFRESH_MS = 60 * 60_000;

/**
 * Background usage refresh for load balancing: Codex usage is free to read; a Claude account only
 * reports usage alongside a request, so one that is idle (no live session) and whose numbers are
 * older than an hour gets a tiny ping — only when there are several Claude accounts to balance.
 * Started by the runtime; returns a stop function.
 */
export function startUsageRefresh(opts: {balancing: () => boolean; busy: (accountId: string) => number}): () => void {
  if (process.env.VITEST || process.env.REIN_NO_USAGE_REFRESH) return () => {};
  let running = false;
  const tick = async () => {
    if (running || !opts.balancing()) return;
    running = true;
    try {
      const {accounts} = await loadAccounts();
      const claude = accounts.filter((a) => a.provider === 'claude');
      for (const account of accounts) {
        const snap = usageStore.get(account.id);
        const age = snap ? Date.now() - snap.at : Infinity;
        if (account.provider === 'codex' && age > CODEX_REFRESH_MS) await adapters.codex.readUsage(account).catch(() => undefined);
        else if (account.provider === 'claude' && claude.length > 1 && age > CLAUDE_IDLE_REFRESH_MS && !opts.busy(account.id)) {
          await adapters.claude.refreshUsage(account).catch(() => undefined);
        }
      }
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 20_000);
  const every = setInterval(() => void tick(), CODEX_REFRESH_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
