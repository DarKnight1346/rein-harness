import React, {useRef, useState} from 'react';
import {Box, Text, useInput, usePaste} from 'ink';
import {
  backspace,
  cursorRow,
  del,
  deleteWordBefore,
  insert,
  killAfter,
  killBefore,
  layout,
  left,
  lineEnd,
  lineStart,
  right,
  vertical,
  wordLeft,
  wordRight,
  type EditState,
} from './inputEdit.js';

type Props = {
  placeholder?: string;
  /** Mask input (e.g. pasted auth codes). */
  mask?: boolean;
  isActive?: boolean;
  /** Controlled mode (e.g. slash-command autocomplete); omit both for uncontrolled. */
  value?: string;
  onChange?(value: string): void;
  onSubmit(value: string): void;
  onCancel?(): void;
  /** Bracketed paste → what to insert (e.g. a `[Pasted text #1 +40 lines]` placeholder). */
  onPaste?(text: string): string | Promise<string>;
  /** Ctrl+V → an `[Image #n]` placeholder for the clipboard's image, if any. */
  onImagePaste?(): Promise<string | undefined>;
  /**
   * ↑ on the first row / ↓ on the last: an earlier (-1) or later (1) message to put in the input,
   * or undefined to stay. Off while a suggestion list uses the arrows.
   */
  onHistory?(dir: -1 | 1, current: string): string | undefined;
  /** Ctrl+T: start or stop voice input; the transcript is inserted at the cursor when it's ready. */
  onVoice?(insert: (text: string) => void): void;
  /** Ctrl+G: edit the draft in $EDITOR; returns the edited text (undefined = keep the draft). */
  onExternalEdit?(current: string): string | undefined;
  /** Columns available: text word-wraps to fit (instead of running off-screen). */
  width?: number;
  /** With width: show at most this many lines (around the cursor). */
  maxLines?: number;
};

/** The input as displayed, word-wrapped to `width` (one extra row when the cursor needs it). */
export function wrapInput(value: string, width: number): string[] {
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
export function TextInput({onVoice, placeholder = '', mask = false, isActive = true, value: controlled, onChange, onSubmit, onCancel, onPaste, onImagePaste, onHistory, onExternalEdit, width, maxLines}: Props) {
  const [own, setOwn] = useState('');
  const value = controlled ?? own;
  // Keystrokes can arrive faster than re-renders; always edit the latest state.
  const state = useRef<EditState>({value, cursor: value.length});
  // A value changed from outside (autocomplete, history, /rewind): the cursor goes to its end.
  if (state.current.value !== value) state.current = {value, cursor: value.length};
  const [, setCursor] = useState(0);
  const apply = (next: EditState) => {
    const changed = next.value !== state.current.value;
    state.current = next;
    setCursor(next.cursor);
    if (!changed) return;
    if (controlled === undefined) setOwn(next.value);
    onChange?.(next.value);
  };
  const replace = (v: string) => apply({value: v, cursor: v.length});
  const add = (text: string) => apply(insert(state.current, text));
  const cols = width ?? Number.MAX_SAFE_INTEGER;

  usePaste(
    (text) => {
      const plain = text.replace(/\r\n?/g, '\n');
      if (!onPaste) return add(plain);
      void Promise.resolve(onPaste(plain)).then(add, () => add(plain));
    },
    {isActive},
  );

  useInput(
    (input, key) => {
      const s = state.current;
      if (key.ctrl && input === 'v' && onImagePaste) {
        void onImagePaste().then((token) => token && add(token));
        return;
      }
      if (key.ctrl && input === 't' && onVoice) {
        onVoice((text) => {
          // Spaced from what's around the cursor.
          const before = state.current.value.slice(0, state.current.cursor);
          add(`${before && !/\s$/.test(before) ? ' ' : ''}${text}`);
        });
        return;
      }
      if (key.ctrl && input === 'g' && onExternalEdit) {
        const edited = onExternalEdit(s.value);
        if (edited !== undefined) replace(edited);
        return;
      }
      if (key.return && (key.shift || key.meta)) add('\n');
      else if (input === '\n' && !key.return) add('\n'); // Ctrl+J
      else if (key.return) {
        if (s.value[s.cursor - 1] === '\\') {
          // backslash-Enter: a new line in every terminal
          apply(insert({value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1}, '\n'));
          return;
        }
        const v = s.value;
        replace('');
        onSubmit(v);
      } else if (key.escape) onCancel?.();
      else if (key.leftArrow) apply(key.meta || key.ctrl ? wordLeft(s) : left(s));
      else if (key.rightArrow) apply(key.meta || key.ctrl ? wordRight(s) : right(s));
      else if (key.home || (key.ctrl && input === 'a')) apply(lineStart(s));
      else if (key.end || (key.ctrl && input === 'e')) apply(lineEnd(s));
      else if (key.meta && input === 'b') apply(wordLeft(s)); // Option+← in Terminal.app / iTerm2
      else if (key.meta && input === 'f') apply(wordRight(s));
      else if (key.backspace) apply(key.meta ? deleteWordBefore(s) : backspace(s));
      else if (key.delete) apply(del(s));
      else if (key.ctrl && input === 'w') apply(deleteWordBefore(s));
      else if (key.ctrl && input === 'u') apply(killBefore(s));
      else if (key.ctrl && input === 'k') apply(killAfter(s));
      else if (key.upArrow || key.downArrow) {
        const dir = key.upArrow ? -1 : 1;
        const moved = vertical(s, cols, dir);
        if (moved) apply(moved);
        else if (onHistory) {
          const recalled = onHistory(dir, s.value);
          if (recalled !== undefined) replace(recalled);
        }
      } else if (input && !key.ctrl && !key.meta && !key.tab) {
        // Pasted text arrives as one chunk; normalize line endings, keep the lines.
        add(input.replace(/\r\n?/g, '\n'));
      }
    },
    {isActive},
  );

  const {cursor} = state.current;
  if (!value) {
    return (
      <Text wrap="truncate">
        <Text inverse> </Text>
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }
  if (mask) {
    return (
      <Text>
        {'•'.repeat(Math.min(value.length, 40))}
        <Text inverse> </Text>
      </Text>
    );
  }
  if (width) {
    // Wrap ourselves so the caller can size the box to the line count, and so the cursor can sit
    // anywhere: the character under it shows inverted.
    const rows = layout(value, width);
    const at = cursorRow(value, rows, cursor, width);
    const lines = rows.map((r) => ({text: value.slice(r.start, r.end), start: r.start}));
    if (at.row >= lines.length) lines.push({text: '', start: value.length});
    let first = 0;
    if (maxLines && lines.length > maxLines) first = Math.min(Math.max(0, at.row - maxLines + 1), lines.length - maxLines);
    const shown = maxLines ? lines.slice(first, first + maxLines) : lines;
    return (
      <Box flexDirection="column" width={width}>
        {shown.map((l, i) => (
          <Text key={first + i} wrap="truncate">
            {first + i === at.row ? withCursor(l.text, cursor - l.start) : l.text || ' '}
          </Text>
        ))}
      </Box>
    );
  }
  return <Text>{withCursor(value, cursor)}</Text>;
}

/** `text` with the character at `index` shown inverted (a space when the cursor is at the end). */
function withCursor(text: string, index: number): React.ReactNode {
  const i = Math.max(0, Math.min(index, text.length));
  const cp = text.codePointAt(i);
  const len = cp !== undefined && cp > 0xffff ? 2 : 1;
  const under = i < text.length && text[i] !== '\n' ? text.slice(i, i + len) : ' ';
  return (
    <>
      {text.slice(0, i)}
      <Text inverse>{under}</Text>
      {i < text.length ? text.slice(i + (under === ' ' && text[i] !== ' ' ? 0 : len)) : ''}
    </>
  );
}
