import { structuredPatch } from 'diff';
const MAX_LINES = 40;
const MAX_DIFF_BYTES = 1024 * 1024;
/**
 * Display diff (2 lines of context) between two versions of a file, capped at 40 lines.
 * Only computed for files up to 1 MB; larger changes get a region-only diff from the caller.
 */
export function fileDiff(before, after) {
    if (before.length > MAX_DIFF_BYTES || after.length > MAX_DIFF_BYTES)
        return undefined;
    const patch = structuredPatch('a', 'b', before, after, '', '', { context: 2 });
    const out = [];
    patch.hunks.forEach((h, hi) => {
        if (hi)
            out.push({ kind: 'gap', text: '⋯' });
        let o = h.oldStart;
        let n = h.newStart;
        for (const line of h.lines) {
            const sign = line[0];
            const text = line.slice(1);
            if (sign === '\\')
                continue; // "\ No newline at end of file"
            if (sign === '-')
                out.push({ kind: 'del', n: o++, text });
            else if (sign === '+')
                out.push({ kind: 'add', n: n++, text });
            else {
                out.push({ kind: 'ctx', n: o, text });
                o++;
                n++;
            }
        }
    });
    return cap(out);
}
/** New file: its first lines as additions. */
export function createdDiff(content) {
    const lines = content.split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    return cap(lines.map((text, i) => ({ kind: 'add', n: i + 1, text })));
}
/** Region-only diff for big files: the replaced lines at `line`, without surrounding context. */
export function regionDiff(line, oldText, newText) {
    return cap([
        ...oldText.split('\n').map((text, i) => ({ kind: 'del', n: line + i, text })),
        ...newText.split('\n').map((text, i) => ({ kind: 'add', n: line + i, text })),
    ]);
}
function cap(lines) {
    if (lines.length <= MAX_LINES)
        return lines;
    const more = lines.length - MAX_LINES;
    return [...lines.slice(0, MAX_LINES), { kind: 'note', text: `… ${more} more diff line${more === 1 ? '' : 's'}` }];
}
export const diffStats = (d) => ({ added: d.filter((l) => l.kind === 'add').length, removed: d.filter((l) => l.kind === 'del').length });
