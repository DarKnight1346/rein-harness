import stripAnsi from 'strip-ansi';
/** Start/end in document order. */
export function ordered(sel) {
    const { anchor: a, focus: f } = sel;
    return a.line < f.line || (a.line === f.line && a.col <= f.col) ? [a, f] : [f, a];
}
/** Selected column range [from, to) on `line`, or undefined if the line isn't selected. */
export function lineRange(sel, line, length) {
    if (!sel)
        return undefined;
    const [s, e] = ordered(sel);
    if (line < s.line || line > e.line)
        return undefined;
    const from = line === s.line ? Math.min(s.col, length) : 0;
    const to = line === e.line ? Math.min(e.col + 1, length) : length;
    return to > from ? [from, to] : undefined;
}
/** Plain text of the selection (ANSI stripped, trailing spaces trimmed per line). */
export function selectedText(sel, lines) {
    const [s, e] = ordered(sel);
    const out = [];
    for (let i = s.line; i <= e.line && i < lines.length; i++) {
        const plain = stripAnsi(lines[i] ?? '');
        const r = lineRange(sel, i, plain.length);
        out.push(r ? plain.slice(r[0], r[1]).replace(/\s+$/, '') : '');
    }
    return out.join('\n');
}
export const isEmpty = (sel) => !sel || (sel.anchor.line === sel.focus.line && sel.anchor.col === sel.focus.col);
