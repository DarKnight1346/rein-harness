import {rm} from 'node:fs/promises';
import path from 'node:path';
import type {Account, ProviderId} from '../providers/types.js';
import {readJson, writeJson} from './json.js';
import {paths, reinHome} from './paths.js';

type AccountsFile = {
  version: 1;
  /** Set once the first-run import of existing logins has been offered. */
  importOffered: boolean;
  accounts: Account[];
};

const EMPTY: AccountsFile = {version: 1, importOffered: false, accounts: []};

export async function loadAccounts(): Promise<AccountsFile> {
  return readJson(paths.accounts(), EMPTY);
}

export async function saveAccounts(file: AccountsFile): Promise<void> {
  await writeJson(paths.accounts(), file);
}

export async function upsertAccount(account: Account): Promise<void> {
  const file = await loadAccounts();
  const i = file.accounts.findIndex((a) => a.id === account.id);
  if (i >= 0) file.accounts[i] = account;
  else file.accounts.push(account);
  await saveAccounts(file);
}

export async function removeAccount(id: string): Promise<void> {
  const file = await loadAccounts();
  file.accounts = file.accounts.filter((a) => a.id !== id);
  await saveAccounts(file);
}

export async function markImportOffered(): Promise<void> {
  const file = await loadAccounts();
  file.importOffered = true;
  await saveAccounts(file);
}

/** `claude-1`, `claude-2`, … — first unused number for the provider. */
export function nextAccountId(provider: ProviderId, existing: Account[]): string {
  const used = new Set(existing.map((a) => a.id));
  for (let n = 1; ; n++) {
    const id = `${provider}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** A fresh Rein-owned account whose CLI home lives under ~/.rein/accounts. */
export function newOwnedAccount(provider: ProviderId, existing: Account[]): Account {
  const id = nextAccountId(provider, existing);
  return {id, provider, home: paths.accountHome(provider, id), imported: false};
}

/** Delete a Rein-owned account's CLI home. Refuses imported/default dirs. */
export async function deleteOwnedHome(account: Account): Promise<void> {
  if (account.imported || account.home === null) return;
  const root = path.resolve(reinHome(), 'accounts') + path.sep;
  if (!path.resolve(account.home).startsWith(root)) {
    throw new Error(`refusing to delete ${account.home}: not under ${root}`);
  }
  await rm(account.home, {recursive: true, force: true});
}
