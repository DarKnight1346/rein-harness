import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { backspace, cursorRow, del, deleteWordBefore, insert, killAfter, killBefore, layout, left, lineEnd, lineStart, right, vertical, wordLeft, wordRight, } from './inputEdit.js';
/** The input as displayed, word-wrapped to `width` (one extra row when the cursor needs it). */
export function wrapInput(value, width) {
    const rows = layout(value, width);
    const lines = rows.map((r) => value.slice(r.start, r.end));
    return cursorRow(value, rows, value.length, width).row >= rows.length ? [...lines, ''] : lines;
}
/**
 * The input box. Kept small on purpose since it lives in the dynamic region, but a real line editor:
 * ←/→ (Option/Alt for words), Home/End and Ctrl+A/E, Backspace/Delete, Ctrl+W / Option+Backspace
 * (word), Ctrl+U / Ctrl+K (to line start / end), ↑/↓ across rows and through message history,
 * Ctrl+G to edit the draft in $EDITOR.
 * New line (Claude Code conventions): Shift+Enter where the terminal reports it (kitty keyboard
 * protocol), Option/Meta+Enter, Ctrl+J, or `\` then Enter. Plain Enter submits.
 */
export function TextInput({ placeholder = '', mask = false, isActive = true, value: controlled, onChange, onSubmit, onCancel, onPaste, onImagePaste, onHistory, onExternalEdit, width, maxLines }) {
    const [own, setOwn] = useState('');
    const value = controlled ?? own;
    // Keystrokes can arrive faster than re-renders; always edit the latest state.
    const state = useRef({ value, cursor: value.length });
    // A value changed from outside (autocomplete, history, /rewind): the cursor goes to its end.
    if (state.current.value !== value)
        state.current = { value, cursor: value.length };
    const [, setCursor] = useState(0);
    const apply = (next) => {
        const changed = next.value !== state.current.value;
        state.current = next;
        setCursor(next.cursor);
        if (!changed)
            return;
        if (controlled === undefined)
            setOwn(next.value);
        onChange?.(next.value);
    };
    const replace = (v) => apply({ value: v, cursor: v.length });
    const add = (text) => apply(insert(state.current, text));
    const cols = width ?? Number.MAX_SAFE_INTEGER;
    usePaste((text) => {
        const plain = text.replace(/\r\n?/g, '\n');
        if (!onPaste)
            return add(plain);
        void Promise.resolve(onPaste(plain)).then(add, () => add(plain));
    }, { isActive });
    useInput((input, key) => {
        const s = state.current;
        if (key.ctrl && input === 'v' && onImagePaste) {
            void onImagePaste().then((token) => token && add(token));
            return;
        }
        if (key.ctrl && input === 'g' && onExternalEdit) {
            const edited = onExternalEdit(s.value);
            if (edited !== undefined)
                replace(edited);
            return;
        }
        if (key.return && (key.shift || key.meta))
            add('\n');
        else if (input === '\n' && !key.return)
            add('\n'); // Ctrl+J
        else if (key.return) {
            if (s.value[s.cursor - 1] === '\\') {
                // backslash-Enter: a new line in every terminal
                apply(insert({ value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 }, '\n'));
                return;
            }
            const v = s.value;
            replace('');
            onSubmit(v);
        }
        else if (key.escape)
            onCancel?.();
        else if (key.leftArrow)
            apply(key.meta || key.ctrl ? wordLeft(s) : left(s));
        else if (key.rightArrow)
            apply(key.meta || key.ctrl ? wordRight(s) : right(s));
        else if (key.home || (key.ctrl && input === 'a'))
            apply(lineStart(s));
        else if (key.end || (key.ctrl && input === 'e'))
            apply(lineEnd(s));
        else if (key.meta && input === 'b')
            apply(wordLeft(s)); // Option+← in Terminal.app / iTerm2
        else if (key.meta && input === 'f')
            apply(wordRight(s));
        else if (key.backspace)
            apply(key.meta ? deleteWordBefore(s) : backspace(s));
        else if (key.delete)
            apply(del(s));
        else if (key.ctrl && input === 'w')
            apply(deleteWordBefore(s));
        else if (key.ctrl && input === 'u')
            apply(killBefore(s));
        else if (key.ctrl && input === 'k')
            apply(killAfter(s));
        else if (key.upArrow || key.downArrow) {
            const dir = key.upArrow ? -1 : 1;
            const moved = vertical(s, cols, dir);
            if (moved)
                apply(moved);
            else if (onHistory) {
                const recalled = onHistory(dir, s.value);
                if (recalled !== undefined)
                    replace(recalled);
            }
        }
        else if (input && !key.ctrl && !key.meta && !key.tab) {
            // Pasted text arrives as one chunk; normalize line endings, keep the lines.
            add(input.replace(/\r\n?/g, '\n'));
        }
    }, { isActive });
    const { cursor } = state.current;
    if (!value) {
        return (_jsxs(Text, { wrap: "truncate", children: [_jsx(Text, { inverse: true, children: " " }), _jsx(Text, { dimColor: true, children: placeholder })] }));
    }
    if (mask) {
        return (_jsxs(Text, { children: ['•'.repeat(Math.min(value.length, 40)), _jsx(Text, { inverse: true, children: " " })] }));
    }
    if (width) {
        // Wrap ourselves so the caller can size the box to the line count, and so the cursor can sit
        // anywhere: the character under it shows inverted.
        const rows = layout(value, width);
        const at = cursorRow(value, rows, cursor, width);
        const lines = rows.map((r) => ({ text: value.slice(r.start, r.end), start: r.start }));
        if (at.row >= lines.length)
            lines.push({ text: '', start: value.length });
        let first = 0;
        if (maxLines && lines.length > maxLines)
            first = Math.min(Math.max(0, at.row - maxLines + 1), lines.length - maxLines);
        const shown = maxLines ? lines.slice(first, first + maxLines) : lines;
        return (_jsx(Box, { flexDirection: "column", width: width, children: shown.map((l, i) => (_jsx(Text, { wrap: "truncate", children: first + i === at.row ? withCursor(l.text, cursor - l.start) : l.text || ' ' }, first + i))) }));
    }
    return _jsx(Text, { children: withCursor(value, cursor) });
}
/** `text` with the character at `index` shown inverted (a space when the cursor is at the end). */
function withCursor(text, index) {
    const i = Math.max(0, Math.min(index, text.length));
    const cp = text.codePointAt(i);
    const len = cp !== undefined && cp > 0xffff ? 2 : 1;
    const under = i < text.length && text[i] !== '\n' ? text.slice(i, i + len) : ' ';
    return (_jsxs(_Fragment, { children: [text.slice(0, i), _jsx(Text, { inverse: true, children: under }), i < text.length ? text.slice(i + (under === ' ' && text[i] !== ' ' ? 0 : len)) : ''] }));
}
