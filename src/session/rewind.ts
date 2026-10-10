import nodePath from 'node:path';
import {runtime} from '../runtime.js';

/** `whole`: a project snapshot exists, so shell-made changes are restored too. */
export type RewindPoint = {index: number; text: string; at: number; files: number; whole?: boolean};
export type RewindMode = 'both' | 'conversation' | 'code';

export const REWIND_MODES: [RewindMode, string, string][] = [
  ['both', 'Restore code and conversation', 'files back to before this message; the conversation ends just before it'],
  ['conversation', 'Restore conversation only', 'files stay as they are now'],
  ['code', 'Restore code only', 'the conversation stays; files go back to before this message'],
];

/** A stored user message as the user typed it (skill prompts back to `/name args`). */
export const displayText = (text: string) => text.replace(/^<skill name="([^"]+)"[\s\S]*?<\/skill>\s*/, '/$1 ');

/** Your messages, newest first, with how many files changed since each (/rewind in both UIs). */
export function rewindPoints(): RewindPoint[] {
  return runtime.engine.transcript.messages
    .map((m, index) => ({m, index}))
    .filter(({m}) => m.role === 'user' && !m.synthetic)
    .map(({m, index}) => ({index, at: m.at, text: displayText(m.text), files: runtime.checkpoints.changedSince(index).length, whole: runtime.snapshots.has(index)}))
    .reverse();
}

/**
 * Rewind to before message `index`: the files (the whole-tree snapshot first, which covers
 * shell-made changes, then Rein's per-file checkpoints for anything outside it), the
 * conversation, or both. Returns the message's text when the conversation was rewound, to go
 * back into the input for editing.
 */
export async function rewindTo(index: number, mode: RewindMode, log: (kind: 'info' | 'error', text: string) => void): Promise<string | undefined> {
  const text = runtime.engine.transcript.messages[index]?.text ?? '';
  if (mode !== 'conversation') {
    const changed = new Set<string>();
    let removedCount = 0;
    if (runtime.snapshots.has(index)) {
      try {
        const t = await runtime.snapshots.restore(index);
        t.restored.forEach((f) => changed.add(f));
        removedCount += t.removed.length;
        t.removed.forEach((f) => changed.add(f));
        for (const f of t.failed) log('error', `Couldn't restore the snapshot of ${f}`);
      } catch (err) {
        log('error', `Couldn't restore the project snapshot: ${(err as Error).message}`);
      }
    }
    const r = runtime.checkpoints.restore(index);
    for (const f of [...r.restored, ...r.removed]) changed.add(nodePath.relative(process.cwd(), f));
    removedCount += r.removed.filter((f) => !changed.has(nodePath.relative(process.cwd(), f))).length;
    const n = changed.size;
    log('info', `Rewound ${n} file${n === 1 ? '' : 's'}${removedCount ? ` (files created since were removed)` : ''}${r.skipped.length ? ` · ${r.skipped.length} too large to restore: ${r.skipped.join(', ')}` : ''}.`);
  }
  if (mode === 'code') return undefined;
  await runtime.engine.rewind(index);
  return displayText(text);
}
