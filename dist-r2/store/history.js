import { readFileSync } from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { updateJsonFileSync } from './json.js';
/** Messages remembered per project for ↑ recall in the input (newest last). */
const MAX_PER_PROJECT = 200;
const file = () => path.join(paths.state(), 'input-history.json');
/** This project's sent messages, oldest first. */
export function loadHistory(project) {
    try {
        const all = JSON.parse(readFileSync(file(), 'utf8'));
        return Array.isArray(all?.[project]) ? all[project].filter((x) => typeof x === 'string') : [];
    }
    catch {
        return [];
    }
}
/** Remember a sent message (an immediate repeat isn't stored twice). */
export function addHistory(project, text) {
    if (!text.trim())
        return;
    try {
        updateJsonFileSync(file(), (all) => {
            const list = Array.isArray(all[project]) ? all[project] : [];
            if (list.at(-1) !== text)
                list.push(text);
            all[project] = list.slice(-MAX_PER_PROJECT);
        });
    }
    catch {
        /* history is a convenience: never fail a send over it */
    }
}
/**
 * ↑/↓ through history. Index `entries.length` is the draft being written; going up from it
 * remembers the draft so ↓ past the newest entry brings it back.
 */
export class HistoryCursor {
    entries;
    index;
    draft = '';
    constructor(entries) {
        this.entries = entries;
        this.index = entries.length;
    }
    reset(entries) {
        this.entries = entries;
        this.index = entries.length;
        this.draft = '';
    }
    move(dir, current) {
        const next = this.index + dir;
        if (next < 0 || next > this.entries.length)
            return undefined;
        if (this.index === this.entries.length)
            this.draft = current;
        this.index = next;
        return next === this.entries.length ? this.draft : this.entries[next];
    }
}
