import os from 'node:os';
import { PROVIDERS } from '../providers/types.js';
import { catalog } from '../router/catalog.js';
import { runtime } from '../runtime.js';
/**
 * "Hide personal info" (/settings → Privacy, on by default): accounts show as "Claude Account 1"
 * instead of an email, and rendered text has known emails and the home folder (which carries the
 * OS username) replaced — so screenshots are safe to share.
 */
export const hidingIdentity = () => runtime.config?.hidePersonalInfo !== false;
/** Display name for an account; `order` numbers accounts not registered yet (the import prompt). */
export function accountName(a, order) {
    if (!hidingIdentity())
        return a.email ?? a.id;
    const list = (order ?? catalog.accountList()).filter((x) => x.provider === a.provider);
    const i = list.findIndex((x) => x.id === a.id);
    return `${PROVIDERS[a.provider].name} Account ${i >= 0 ? i + 1 : list.length + 1}`;
}
const home = os.homedir();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Replace known account emails and the home folder in display text (no-op when the option is off). */
export function redact(text) {
    if (!hidingIdentity() || !text)
        return text;
    let out = text;
    for (const a of catalog.accountList())
        if (a.email && out.includes(a.email))
            out = out.replace(new RegExp(escape(a.email), 'gi'), accountName(a));
    if (home.length > 1 && out.includes(home))
        out = out.split(home).join('~');
    const user = os.userInfo().username;
    // The username alone (e.g. inside other paths) — only when it's distinctive enough not to hit words.
    if (user.length >= 5 && out.includes(user))
        out = out.replace(new RegExp(`\\b${escape(user)}\\b`, 'g'), 'user');
    return out;
}
