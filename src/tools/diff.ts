import {structuredPatch} from 'diff';

/** One displayed diff line: `n` is the line number (old numbering for removed/context, new for added). */
export type DiffLine = {kind: 'ctx' | 'del' | 'add' | 'gap' | 'note'; n?: number; text: string};

const MAX_LINES = 40;
const MAX_DIFF_BYTES = 1024 * 1024;

/**
 * Display diff (2 lines of context) between two versions of a file, capped at 40 lines.
 * Only computed for files up to 1 MB; larger changes get a region-only diff from the caller.
 */
export function fileDiff(before: string, after: string): DiffLine[] | undefined {
  if (before.length > MAX_DIFF_BYTES || after.length > MAX_DIFF_BYTES) return undefined;
  const patch = structuredPatch('a', 'b', before, after, '', '', {context: 2});
  const out: DiffLine[] = [];
  patch.hunks.forEach((h, hi) => {
    if (hi) out.push({kind: 'gap', text: '⋯'});
    let o = h.oldStart;
    let n = h.newStart;
    for (const line of h.lines) {
      const sign = line[0];
      const text = line.slice(1);
      if (sign === '\\') continue; // "\ No newline at end of file"
      if (sign === '-') out.push({kind: 'del', n: o++, text});
      else if (sign === '+') out.push({kind: 'add', n: n++, text});
      else {
        out.push({kind: 'ctx', n: o, text});
        o++;
        n++;
      }
    }
  });
  return cap(out);
}

/** New file: its first lines as additions. */
export function createdDiff(content: string): DiffLine[] {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return cap(lines.map((text, i) => ({kind: 'add' as const, n: i + 1, text})));
}

/** Region-only diff for big files: the replaced lines at `line`, without surrounding context. */
export function regionDiff(line: number, oldText: string, newText: string): DiffLine[] {
  return cap([
    ...oldText.split('\n').map((text, i) => ({kind: 'del' as const, n: line + i, text})),
    ...newText.split('\n').map((text, i) => ({kind: 'add' as const, n: line + i, text})),
  ]);
}

function cap(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= MAX_LINES) return lines;
  const more = lines.length - MAX_LINES;
  return [...lines.slice(0, MAX_LINES), {kind: 'note', text: `… ${more} more diff line${more === 1 ? '' : 's'}`}];
}

export const diffStats = (d: DiffLine[]) => ({added: d.filter((l) => l.kind === 'add').length, removed: d.filter((l) => l.kind === 'del').length});
