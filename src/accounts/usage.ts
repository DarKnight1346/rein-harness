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
