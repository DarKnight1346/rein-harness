import {describe, expect, it} from 'vitest';
import {backspace, cursorRow, del, deleteWordBefore, insert, killAfter, killBefore, layout, left, lineEnd, lineStart, right, vertical, wordLeft, wordRight, type EditState} from '../src/ui/inputEdit.js';
import {HistoryCursor} from '../src/store/history.js';
import {wrapInput} from '../src/ui/TextInput.js';

const at = (value: string, cursor = value.length): EditState => ({value, cursor});

describe('input editing', () => {
  it('inserts and deletes at the cursor, not just the end', () => {
    let s = left(left(at('helo')));
    s = insert(right(s), 'l');
    expect(s).toEqual({value: 'hello', cursor: 4});
    expect(backspace(s)).toEqual({value: 'helo', cursor: 3});
    expect(del(at('hello', 0))).toEqual({value: 'ello', cursor: 0});
    expect(del(at('hi'))).toEqual(at('hi'));
  });

  it('moves and deletes by word', () => {
    const s = at('fix the  flaky test');
    expect(wordLeft(s).cursor).toBe(15);
    expect(wordLeft(wordLeft(s)).cursor).toBe(9);
    expect(wordRight(at(s.value, 0)).cursor).toBe(3);
    expect(deleteWordBefore(s).value).toBe('fix the  flaky ');
    expect(deleteWordBefore(at('a b   ', 6)).value).toBe('a ');
  });

  it('Home/End and Ctrl+U/K work on the current line', () => {
    const s = at('line one\nline two', 13);
    expect(lineStart(s).cursor).toBe(9);
    expect(lineEnd(s).cursor).toBe(17);
    expect(killBefore(s)).toEqual({value: 'line one\n two', cursor: 9});
    expect(killAfter(s)).toEqual({value: 'line one\nline', cursor: 13});
    expect(killBefore(at('single line'))).toEqual(at('')); // one line: clears the draft, as before
  });

  it('deletes a placeholder token whole when it is right before the cursor', () => {
    const v = 'see [Image #1] and [Pasted text #2 +40 lines]';
    expect(backspace(at(v)).value).toBe('see [Image #1] and ');
    expect(backspace(at(v, 14)).value).toBe('see  and [Pasted text #2 +40 lines]');
  });

  it('treats an emoji as one character', () => {
    const s = at('ok 👍');
    expect(left(s).cursor).toBe(3);
    expect(backspace(s).value).toBe('ok ');
  });
});

describe('input layout', () => {
  it('word-wraps with offsets and places the cursor', () => {
    const v = 'the quick brown fox';
    const rows = layout(v, 10);
    expect(rows.map((r) => v.slice(r.start, r.end))).toEqual(['the quick', 'brown fox']);
    expect(cursorRow(v, rows, 0, 10)).toEqual({row: 0, col: 0});
    expect(cursorRow(v, rows, 12, 10)).toEqual({row: 1, col: 2});
    expect(cursorRow(v, rows, v.length, 10)).toEqual({row: 1, col: 9});
  });

  it('keeps explicit new lines and breaks long words', () => {
    const v = 'abcdefghij\nxy';
    expect(layout(v, 4).map((r) => v.slice(r.start, r.end))).toEqual(['abcd', 'efgh', 'ij', 'xy']);
    expect(wrapInput('abcd', 4)).toEqual(['abcd', '']); // room for the cursor after a full row
  });

  it('moves up and down across rows, keeping the column', () => {
    const v = 'first line\nsecond';
    const down = vertical(at(v, 3), 80, 1)!;
    expect(down.cursor).toBe(14);
    expect(vertical(down, 80, -1)!.cursor).toBe(3);
    expect(vertical(at(v, 3), 80, -1)).toBeUndefined(); // top row: history takes over
  });
});

describe('input history', () => {
  it('walks back through sent messages and returns to the draft', () => {
    const h = new HistoryCursor(['first', 'second']);
    expect(h.move(-1, 'draft in progress')).toBe('second');
    expect(h.move(-1, 'second')).toBe('first');
    expect(h.move(-1, 'first')).toBeUndefined();
    expect(h.move(1, 'first')).toBe('second');
    expect(h.move(1, 'second')).toBe('draft in progress');
    expect(h.move(1, 'draft in progress')).toBeUndefined();
  });
});
