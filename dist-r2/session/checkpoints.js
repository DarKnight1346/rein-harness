import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { reinHome } from '../store/paths.js';
/** Files larger than this aren't snapshotted (the rewind will say so). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A deleted directory with more files than this isn't snapshotted file by file. */
const MAX_DIR_FILES = 500;
export class Checkpoints {
    sessionId;
    snaps;
    seen = new Set();
    /** Conversation the cached index belongs to (another one is loaded after /resume or /clear). */
    loadedFor;
    constructor(sessionId) {
        this.sessionId = sessionId;
    }
    dir() {
        return path.join(reinHome(), 'checkpoints', this.sessionId());
    }
    load() {
        if (this.loadedFor !== this.sessionId())
            this.reset();
        if (this.snaps)
            return this.snaps;
        this.loadedFor = this.sessionId();
        const file = path.join(this.dir(), 'index.jsonl');
        let text = '';
        try {
            text = readFileSync(file, 'utf8');
        }
        catch { }
        this.snaps = text
            ? text
                .split('\n')
                .filter(Boolean)
                .flatMap((l) => {
                try {
                    return [JSON.parse(l)];
                }
                catch {
                    return [];
                }
            })
            : [];
        for (const s of this.snaps)
            this.seen.add(`${s.turn}\u0000${s.file}`);
        return this.snaps;
    }
    /** Save `file`'s current state (or its absence) before turn `turn` changes it — once per turn. */
    async snapshot(turn, file) {
        const snaps = this.load();
        // One open: whether it exists, its size and its contents all come from the same file.
        let fd;
        let isDir = false;
        try {
            fd = openSync(file, 'r');
            isDir = fstatSync(fd).isDirectory();
        }
        catch (err) {
            isDir = err.code === 'EISDIR'; // Windows can't open directories
        }
        if (isDir) {
            if (fd !== undefined)
                closeSync(fd);
            const files = listFiles(file);
            if (files.length <= MAX_DIR_FILES)
                for (const f of files)
                    await this.snapshot(turn, f);
            return;
        }
        const key = `${turn}\u0000${file}`;
        if (this.seen.has(key)) {
            if (fd !== undefined)
                closeSync(fd);
            return;
        }
        this.seen.add(key);
        let snap = { turn, file, existed: fd !== undefined };
        if (fd !== undefined) {
            try {
                if (fstatSync(fd).size <= MAX_FILE_BYTES) {
                    const data = readFileSync(fd);
                    const blob = createHash('sha256').update(data).digest('hex');
                    const blobFile = path.join(this.dir(), 'blobs', blob);
                    mkdirSync(path.dirname(blobFile), { recursive: true, mode: 0o700 });
                    try {
                        writeFileSync(blobFile, data, { mode: 0o600, flag: 'wx' }); // content-addressed: exists = same data
                    }
                    catch (err) {
                        if (err.code !== 'EEXIST')
                            throw err;
                    }
                    snap = { ...snap, blob };
                }
            }
            finally {
                closeSync(fd);
            }
        }
        snaps.push(snap);
        mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
        await appendFile(path.join(this.dir(), 'index.jsonl'), JSON.stringify(snap) + '\n', { mode: 0o600 });
    }
    /** Files changed at or after `turn` (what a rewind to it would restore). */
    changedSince(turn) {
        return [...new Set(this.load().filter((s) => s.turn >= turn).map((s) => s.file))];
    }
    /**
     * Put every file changed at or after `turn` back to its state before that turn. Returns what
     * was restored, removed (didn't exist yet) and skipped (too large to have been saved).
     */
    restore(turn) {
        const out = { restored: [], removed: [], skipped: [] };
        const earliest = new Map();
        for (const s of this.load())
            if (s.turn >= turn && !earliest.has(s.file))
                earliest.set(s.file, s);
        for (const s of earliest.values()) {
            if (!s.existed) {
                rmSync(s.file, { force: true });
                out.removed.push(s.file);
            }
            else {
                let data;
                try {
                    data = s.blob ? readFileSync(path.join(this.dir(), 'blobs', s.blob)) : undefined;
                }
                catch { }
                if (data) {
                    mkdirSync(path.dirname(s.file), { recursive: true });
                    writeFileSync(s.file, data);
                    out.restored.push(s.file);
                }
                else
                    out.skipped.push(s.file);
            }
        }
        // Later changes are now undone; forget them so a new turn N snapshots afresh.
        this.snaps = this.load().filter((s) => s.turn < turn);
        this.seen = new Set(this.snaps.map((s) => `${s.turn}\u0000${s.file}`));
        mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
        writeFileSync(path.join(this.dir(), 'index.jsonl'), this.snaps.map((s) => JSON.stringify(s) + '\n').join(''), { mode: 0o600 });
        return out;
    }
    /** Switched conversations: drop the cached index (another session's store applies). */
    reset() {
        this.snaps = undefined;
        this.seen.clear();
    }
}
function listFiles(dir) {
    const out = [];
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            if (out.length > MAX_DIR_FILES)
                return;
            const p = path.join(d, e.name);
            if (e.isDirectory())
                walk(p);
            else if (e.isFile())
                out.push(p);
        }
    };
    walk(dir);
    return out;
}
