import {createHash} from 'node:crypto';
import {closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {appendFile} from 'node:fs/promises';
import path from 'node:path';
import {reinHome} from '../store/paths.js';

/**
 * File checkpoints for /rewind (like Claude Code's): before a tool changes a file, its previous
 * state is saved once per turn (the user message index). Rewinding to a turn restores every file
 * changed since to how it was before that turn — including deleting files that didn't exist yet.
 * Only Rein's file tools are tracked; changes made through `shell` aren't (same as Claude Code).
 *
 * Storage per session: checkpoints/<session>/index.jsonl ({turn, file, existed, blob}) and
 * content-addressed blobs/<sha256>.
 */
export type Snapshot = {turn: number; file: string; existed: boolean; blob?: string};

/** Files larger than this aren't snapshotted (the rewind will say so). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A deleted directory with more files than this isn't snapshotted file by file. */
const MAX_DIR_FILES = 500;

export class Checkpoints {
  private snaps: Snapshot[] | undefined;
  private seen = new Set<string>();
  /** Conversation the cached index belongs to (another one is loaded after /resume or /clear). */
  private loadedFor: string | undefined;

  constructor(private readonly sessionId: () => string) {}

  private dir(): string {
    return path.join(reinHome(), 'checkpoints', this.sessionId());
  }

  private load(): Snapshot[] {
    if (this.loadedFor !== this.sessionId()) this.reset();
    if (this.snaps) return this.snaps;
    this.loadedFor = this.sessionId();
    const file = path.join(this.dir(), 'index.jsonl');
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {}
    this.snaps = text
      ? text
          .split('\n')
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l) as Snapshot];
            } catch {
              return [];
            }
          })
      : [];
    for (const s of this.snaps) this.seen.add(`${s.turn}\u0000${s.file}`);
    return this.snaps;
  }

  /** Save `file`'s current state (or its absence) before turn `turn` changes it — once per turn. */
  async snapshot(turn: number, file: string): Promise<void> {
    const snaps = this.load();
    // One open: whether it exists, its size and its contents all come from the same file.
    let fd: number | undefined;
    let isDir = false;
    try {
      fd = openSync(file, 'r');
      isDir = fstatSync(fd).isDirectory();
    } catch (err) {
      isDir = (err as NodeJS.ErrnoException).code === 'EISDIR'; // Windows can't open directories
    }
    if (isDir) {
      if (fd !== undefined) closeSync(fd);
      const files = listFiles(file);
      if (files.length <= MAX_DIR_FILES) for (const f of files) await this.snapshot(turn, f);
      return;
    }
    const key = `${turn}\u0000${file}`;
    if (this.seen.has(key)) {
      if (fd !== undefined) closeSync(fd);
      return;
    }
    this.seen.add(key);
    let snap: Snapshot = {turn, file, existed: fd !== undefined};
    if (fd !== undefined) {
      try {
        if (fstatSync(fd).size <= MAX_FILE_BYTES) {
          const data = readFileSync(fd);
          const blob = createHash('sha256').update(data).digest('hex');
          const blobFile = path.join(this.dir(), 'blobs', blob);
          mkdirSync(path.dirname(blobFile), {recursive: true, mode: 0o700});
          try {
            writeFileSync(blobFile, data, {mode: 0o600, flag: 'wx'}); // content-addressed: exists = same data
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          }
          snap = {...snap, blob};
        }
      } finally {
        closeSync(fd);
      }
    }
    snaps.push(snap);
    mkdirSync(this.dir(), {recursive: true, mode: 0o700});
    await appendFile(path.join(this.dir(), 'index.jsonl'), JSON.stringify(snap) + '\n', {mode: 0o600});
  }

  /** Files changed at or after `turn` (what a rewind to it would restore). */
  changedSince(turn: number): string[] {
    return [...new Set(this.load().filter((s) => s.turn >= turn).map((s) => s.file))];
  }

  /**
   * Put every file changed at or after `turn` back to its state before that turn. Returns what
   * was restored, removed (didn't exist yet) and skipped (too large to have been saved).
   */
  restore(turn: number): {restored: string[]; removed: string[]; skipped: string[]} {
    const out = {restored: [] as string[], removed: [] as string[], skipped: [] as string[]};
    const earliest = new Map<string, Snapshot>();
    for (const s of this.load()) if (s.turn >= turn && !earliest.has(s.file)) earliest.set(s.file, s);
    for (const s of earliest.values()) {
      if (!s.existed) {
        rmSync(s.file, {force: true});
        out.removed.push(s.file);
      } else {
        let data: Buffer | undefined;
        try {
          data = s.blob ? readFileSync(path.join(this.dir(), 'blobs', s.blob)) : undefined;
        } catch {}
        if (data) {
          mkdirSync(path.dirname(s.file), {recursive: true});
          writeFileSync(s.file, data);
          out.restored.push(s.file);
        } else out.skipped.push(s.file);
      }
    }
    // Later changes are now undone; forget them so a new turn N snapshots afresh.
    this.snaps = this.load().filter((s) => s.turn < turn);
    this.seen = new Set(this.snaps.map((s) => `${s.turn}\u0000${s.file}`));
    mkdirSync(this.dir(), {recursive: true, mode: 0o700});
    writeFileSync(path.join(this.dir(), 'index.jsonl'), this.snaps.map((s) => JSON.stringify(s) + '\n').join(''), {mode: 0o600});
    return out;
  }

  /** Switched conversations: drop the cached index (another session's store applies). */
  reset(): void {
    this.snaps = undefined;
    this.seen.clear();
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, {withFileTypes: true})) {
      if (out.length > MAX_DIR_FILES) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}
