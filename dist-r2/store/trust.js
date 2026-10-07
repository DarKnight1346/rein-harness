import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { updateJsonFileSync } from './json.js';
/**
 * Projects whose hooks the user reviewed and trusted, keyed by real path. The trust is tied to a
 * hash of the hooks as they were reviewed: any change to them (a `git pull`, or the agent editing
 * the settings file) needs a new yes before they run.
 */
const file = () => path.join(paths.state(), 'trusted-projects.json');
const key = (root) => {
    try {
        return realpathSync(root);
    }
    catch {
        return path.resolve(root);
    }
};
export function trustedHooksHash(root) {
    try {
        const all = JSON.parse(readFileSync(file(), 'utf8'));
        const entry = all?.[key(root)];
        return typeof entry?.hooks === 'string' ? entry.hooks : undefined;
    }
    catch {
        return undefined;
    }
}
export function trustHooks(root, hash) {
    updateJsonFileSync(file(), (all) => {
        all[key(root)] = { ...(all[key(root)] ?? {}), hooks: hash, at: new Date().toISOString() };
    });
}
