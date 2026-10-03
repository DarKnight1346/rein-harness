import React, {useRef, useState} from 'react';
import {Box, Text, useInput, usePaste} from 'ink';
import wrapAnsi from 'wrap-ansi';
import {TRAILING_TOKEN_RE} from './attachments.js';

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
  /** Columns available: text word-wraps to fit (instead of running off-screen). */
  width?: number;
  /** With width: show at most this many lines (the last ones, where the cursor is). */
  maxLines?: number;
};

/** The input as displayed: word-wrapped to `width`, with room for the cursor after the last character. */
export function wrapInput(value: string, width: number): string[] {
  const w = Math.max(1, width);
  return wrapAnsi(`${value} `, w, {hard: true, trim: false, wordWrap: true})
    .split('\n')
    .map((l) => (l.length > w && l.endsWith(' ') ? l.slice(0, w) : l));
}

/**
 * Minimal input; kept tiny on purpose since it lives in the dynamic region.
 * New line (Claude Code conventions): Shift+Enter where the terminal reports it (kitty keyboard
 * protocol), Option/Meta+Enter, Ctrl+J, or `\` then Enter. Plain Enter submits. Pasted text keeps
 * its newlines.
 */
export function TextInput({placeholder = '', mask = false, isActive = true, value: controlled, onChange, onSubmit, onCancel, onPaste, onImagePaste, width, maxLines}: Props) {
  const [own, setOwn] = useState('');
  const value = controlled ?? own;
  // Keystrokes can arrive faster than re-renders; always edit the latest value.
  const latest = useRef(value);
  latest.current = value;
  const set = (v: string) => {
    latest.current = v;
    if (controlled === undefined) setOwn(v);
    onChange?.(v);
  };

  const append = (s: string) => set(latest.current + s);

  usePaste(
    (text) => {
      const plain = text.replace(/\r\n?/g, '\n');
      if (!onPaste) return append(plain);
      void Promise.resolve(onPaste(plain)).then(append, () => append(plain));
    },
    {isActive},
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'v' && onImagePaste) {
        void onImagePaste().then((token) => token && append(token));
        return;
      }
      if (key.return && (key.shift || key.meta)) {
        set(latest.current + '\n');
      } else if (input === '\n' && !key.return) {
        set(latest.current + '\n'); // Ctrl+J
      } else if (key.return) {
        const v = latest.current;
        if (v.endsWith('\\')) {
          set(v.slice(0, -1) + '\n'); // backslash-Enter: works in every terminal
          return;
        }
        set('');
        onSubmit(v);
      } else if (key.escape) {
        onCancel?.();
      } else if (key.backspace || key.delete) {
        // A placeholder token is deleted whole (its attachment goes with it).
        const token = TRAILING_TOKEN_RE.exec(latest.current);
        set(token ? latest.current.slice(0, token.index) : latest.current.slice(0, -1));
      } else if (key.ctrl && input === 'u') {
        set('');
      } else if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab) {
        // Pasted text arrives as one chunk; normalize line endings, keep the lines.
        set(latest.current + input.replace(/\r\n?/g, '\n'));
      }
    },
    {isActive},
  );

  if (!value) {
    return (
      <Text wrap="truncate">
        <Text inverse> </Text>
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }
  if (width && !mask) {
    // Wrap ourselves so the caller can size the box to the line count; the cursor sits after the
    // last character (the trailing space wrapInput leaves room for).
    let lines = wrapInput(value, width);
    if (maxLines && lines.length > maxLines) lines = lines.slice(-maxLines);
    return (
      <Box flexDirection="column" width={width}>
        {lines.map((l, i) =>
          i < lines.length - 1 ? (
            <Text key={i} wrap="truncate">
              {l || ' '}
            </Text>
          ) : (
            <Text key={i} wrap="truncate">
              {l.slice(0, -1)}
              <Text inverse> </Text>
            </Text>
          ),
        )}
      </Box>
    );
  }
  return (
    <Text>
      {mask ? '•'.repeat(Math.min(value.length, 40)) : value}
      <Text inverse> </Text>
    </Text>
  );
}
