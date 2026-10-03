import {auth, defaultAccount} from '../providers/index.js';
import {usageStore} from '../store/usage.js';
import type {Account, AccountStatus, LoginFlow, ProviderId} from '../providers/types.js';
import {
  deleteOwnedHome,
  loadAccounts,
  markImportOffered,
  newOwnedAccount,
  removeAccount as unregister,
  upsertAccount,
} from '../store/accounts.js';

export type AccountRow = {account: Account; status: AccountStatus};

export async function listAccounts(): Promise<AccountRow[]> {
  const {accounts} = await loadAccounts();
  return Promise.all(accounts.map(async (account) => ({account, status: await auth[account.provider].status(account)})));
}

/** Existing CLI logins (~/.claude, ~/.codex) not yet registered. `undefined` once already offered. */
export async function detectImports(): Promise<AccountRow[] | undefined> {
  const file = await loadAccounts();
  if (file.importOffered) return undefined;
  const providers: ProviderId[] = ['claude', 'codex'];
  const rows = await Promise.all(
    providers
      .filter((p) => !file.accounts.some((a) => a.provider === p && a.home === null))
      .map(async (p) => {
        const account = defaultAccount(p);
        return {account, status: await auth[p].status(account)};
      }),
  );
  return rows.filter((r) => r.status.loggedIn);
}

export async function importAccounts(rows: AccountRow[]): Promise<void> {
  for (const {account, status} of rows) {
    await upsertAccount(withIdentity(account, status));
  }
  await markImportOffered();
}

export async function skipImport(): Promise<void> {
  await markImportOffered();
}

function withIdentity(account: Account, status: AccountStatus): Account {
  return status.loggedIn ? {...account, email: status.email, plan: status.plan} : account;
}

/**
 * Start adding a Rein-owned account. The caller drives `flow` (shows URL, forwards a pasted code)
 * and then calls `finishAdd` with the final status.
 */
export async function startAdd(provider: ProviderId): Promise<{account: Account; flow: LoginFlow}> {
  const {accounts} = await loadAccounts();
  const account = newOwnedAccount(provider, accounts);
  return {account, flow: auth[provider].login(account)};
}

export async function finishAdd(account: Account, status: AccountStatus): Promise<Account> {
  if (!status.loggedIn) {
    await deleteOwnedHome(account);
    throw new Error('login did not complete');
  }
  const {accounts} = await loadAccounts();
  const dup = status.email && accounts.find((a) => a.provider === account.provider && a.email === status.email);
  if (dup) {
    // Same login twice would just split one quota across two "accounts".
    await auth[account.provider].logout(account).catch(() => {});
    await deleteOwnedHome(account);
    throw new Error(`${status.email} is already registered as ${dup.id}`);
  }
  const saved = withIdentity(account, status);
  await upsertAccount(saved);
  return saved;
}

export async function abandonAdd(account: Account): Promise<void> {
  await deleteOwnedHome(account);
}

/** Imported logins are only unregistered — never logged out (they belong to the user's normal CLI). */
/**
 * Remove an account. It's unregistered at once (never picked again); logging out and deleting a
 * Rein-owned home waits for `idle` — sessions still running on it finish first. Imported accounts
 * are only unregistered: the user's own CLI login is never touched.
 */
export async function removeAccount(account: Account, idle: () => Promise<void> = async () => {}): Promise<void> {
  await unregister(account.id);
  usageStore.forget(account.id);
  if (!account.imported && account.home !== null) {
    await idle();
    await auth[account.provider].logout(account).catch(() => {});
    await deleteOwnedHome(account);
  }
}

/** Re-run login for an existing account (expired tokens). Imported accounts re-auth in place. */
export function reauth(account: Account): LoginFlow {
  return auth[account.provider].login(account);
}

export async function saveIdentity(account: Account, status: AccountStatus): Promise<void> {
  await upsertAccount(withIdentity(account, status));
}
