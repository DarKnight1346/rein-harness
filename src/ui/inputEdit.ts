import stringWidth from 'string-width';
import {TRAILING_TOKEN_RE} from './attachments.js';

/** The input box's text and cursor (a UTF-16 offset into `value`). */
export type EditState = {value: string; cursor: number};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function insert(s: EditState, text: string): EditState {
  return {value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), cursor: s.cursor + text.length};
}

/** Backspace: one character, or a whole `[Pasted text #1 …]` / `[Image #2]` token right before the cursor. */
export function backspace(s: EditState): EditState {
  if (!s.cursor) return s;
  const before = s.value.slice(0, s.cursor);
  const token = TRAILING_TOKEN_RE.exec(before);
  const from = token ? token.index : prevChar(s.value, s.cursor);
  return {value: s.value.slice(0, from) + s.value.slice(s.cursor), cursor: from};
}

/** Forward delete (fn+Delete / Del). */
export function del(s: EditState): EditState {
  if (s.cursor >= s.value.length) return s;
  return {value: s.value.slice(0, s.cursor) + s.value.slice(nextChar(s.value, s.cursor)), cursor: s.cursor};
}

// Surrogate pairs (emoji) move as one character.
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const prevChar = (v: string, i: number) => (i >= 2 && isLow(v.charCodeAt(i - 1)) ? i - 2 : Math.max(0, i - 1));
const nextChar = (v: string, i: number) => (i < v.length - 1 && isLow(v.charCodeAt(i + 1)) ? i + 2 : Math.min(v.length, i + 1));

export const left = (s: EditState): EditState => ({...s, cursor: prevChar(s.value, s.cursor)});
export const right = (s: EditState): EditState => ({...s, cursor: nextChar(s.value, s.cursor)});

/** Start of the word before the cursor (skipping whitespace first), like Option+← / Ctrl+W. */
export function wordStart(v: string, i: number): number {
  let j = i;
  while (j > 0 && /\s/.test(v[j - 1]!)) j--;
  while (j > 0 && !/\s/.test(v[j - 1]!)) j--;
  return j;
}
/** End of the word after the cursor, like Option+→. */
export function wordEnd(v: string, i: number): number {
  let j = i;
  while (j < v.length && /\s/.test(v[j]!)) j++;
  while (j < v.length && !/\s/.test(v[j]!)) j++;
  return j;
}
export const wordLeft = (s: EditState): EditState => ({...s, cursor: wordStart(s.value, s.cursor)});
export const wordRight = (s: EditState): EditState => ({...s, cursor: wordEnd(s.value, s.cursor)});
export function deleteWordBefore(s: EditState): EditState {
  const from = wordStart(s.value, s.cursor);
  return {value: s.value.slice(0, from) + s.value.slice(s.cursor), cursor: from};
}

/** Start / end of the current logical line (Home, End, Ctrl+A, Ctrl+E). */
export const lineStart = (s: EditState): EditState => ({...s, cursor: s.value.lastIndexOf('\n', s.cursor - 1) + 1});
export function lineEnd(s: EditState): EditState {
  const nl = s.value.indexOf('\n', s.cursor);
  return {...s, cursor: nl === -1 ? s.value.length : nl};
}
/** Ctrl+U: delete everything before the cursor on this line (the whole draft when it's one line). */
export function killBefore(s: EditState): EditState {
  const from = s.value.lastIndexOf('\n', s.cursor - 1) + 1;
  return {value: s.value.slice(0, from) + s.value.slice(s.cursor), cursor: from};
}
/** Ctrl+K: delete to the end of the line. */
export function killAfter(s: EditState): EditState {
  const nl = s.value.indexOf('\n', s.cursor);
  const to = nl === -1 ? s.value.length : nl === s.cursor ? nl + 1 : nl;
  return {value: s.value.slice(0, s.cursor) + s.value.slice(to), cursor: s.cursor};
}

/** One displayed row: `value.slice(start, end)` (a trailing space or the `\n` that ended it is excluded). */
export type Row = {start: number; end: number};

/**
 * Word-wrap `value` into rows of at most `width` columns, keeping each row's offsets so the cursor
 * can be placed. Breaks at the last space that fits, else mid-word. A row that ends exactly at the
 * width is followed by an empty row when the cursor sits after it (so it never overflows).
 */
export function layout(value: string, width: number): Row[] {
  const w = Math.max(1, width);
  const rows: Row[] = [];
  let start = 0;
  for (const para of value.split('\n')) {
    const end = start + para.length;
    let rowStart = start;
    let col = 0;
    let lastSpace = -1;
    for (let i = start; i < end; i = nextChar(value, i)) {
      const ch = value.slice(i, nextChar(value, i));
      const cw = stringWidth(ch);
      if (col + cw > w && i > rowStart) {
        if (lastSpace >= rowStart) {
          rows.push({start: rowStart, end: lastSpace});
          rowStart = lastSpace + 1;
        } else {
          rows.push({start: rowStart, end: i});
          rowStart = i;
        }
        col = stringWidth(value.slice(rowStart, i));
        lastSpace = -1;
      }
      if (ch === ' ') lastSpace = i;
      col += cw;
    }
    rows.push({start: rowStart, end});
    start = end + 1;
  }
  return rows;
}

/** The row the cursor is on, and its column there. At a soft wrap the cursor belongs to the next row. */
export function cursorRow(value: string, rows: Row[], cursor: number, width: number): {row: number; col: number} {
  for (let r = 0; r < rows.length; r++) {
    const {start, end} = rows[r]!;
    const next = rows[r + 1];
    const softWrapped = next !== undefined && value[end] !== '\n';
    if (cursor >= start && (cursor < end || (cursor === end && (!softWrapped || cursor < next.start)))) {
      const col = stringWidth(value.slice(start, cursor));
      // A full row with the cursor at its end: the cursor shows on a fresh row below.
      if (col >= Math.max(1, width) && cursor === end && r === rows.length - 1) return {row: r + 1, col: 0};
      return {row: r, col};
    }
  }
  return {row: rows.length - 1, col: 0};
}

/** Move up/down a displayed row, keeping the column. Undefined when already on the first/last row. */
export function vertical(s: EditState, width: number, dir: -1 | 1): EditState | undefined {
  const rows = layout(s.value, width);
  const {row, col} = cursorRow(s.value, rows, s.cursor, width);
  const target = rows[row + dir];
  if (!target) return undefined;
  let cursor = target.start;
  while (cursor < target.end && stringWidth(s.value.slice(target.start, nextChar(s.value, cursor))) <= col) cursor = nextChar(s.value, cursor);
  return {...s, cursor: clamp(cursor, target.start, target.end)};
}
