import { rm } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './json.js';
import { paths, reinHome } from './paths.js';
const EMPTY = { version: 1, importOffered: false, accounts: [] };
export async function loadAccounts() {
    return readJson(paths.accounts(), EMPTY);
}
export async function saveAccounts(file) {
    await writeJson(paths.accounts(), file);
}
export async function upsertAccount(account) {
    const file = await loadAccounts();
    const i = file.accounts.findIndex((a) => a.id === account.id);
    if (i >= 0)
        file.accounts[i] = account;
    else
        file.accounts.push(account);
    await saveAccounts(file);
}
export async function removeAccount(id) {
    const file = await loadAccounts();
    file.accounts = file.accounts.filter((a) => a.id !== id);
    await saveAccounts(file);
}
export async function markImportOffered() {
    const file = await loadAccounts();
    file.importOffered = true;
    await saveAccounts(file);
}
/** `claude-1`, `claude-2`, … — first unused number for the provider. */
export function nextAccountId(provider, existing) {
    const used = new Set(existing.map((a) => a.id));
    for (let n = 1;; n++) {
        const id = `${provider}-${n}`;
        if (!used.has(id))
            return id;
    }
}
/** A fresh Rein-owned account whose CLI home lives under ~/.rein/accounts. */
export function newOwnedAccount(provider, existing) {
    const id = nextAccountId(provider, existing);
    return { id, provider, home: paths.accountHome(provider, id), imported: false };
}
/** Delete a Rein-owned account's CLI home. Refuses imported/default dirs. */
export async function deleteOwnedHome(account) {
    if (account.imported || account.home === null)
        return;
    const root = path.resolve(reinHome(), 'accounts') + path.sep;
    if (!path.resolve(account.home).startsWith(root)) {
        throw new Error(`refusing to delete ${account.home}: not under ${root}`);
    }
    await rm(account.home, { recursive: true, force: true });
}
