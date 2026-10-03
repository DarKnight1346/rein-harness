import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {age} from './format.js';
import {Clickable} from './terminal/clicks.js';

/** `whole`: a project snapshot exists, so shell-made changes are restored too. */
export type RewindPoint = {index: number; text: string; at: number; files: number; whole?: boolean};
export type RewindMode = 'both' | 'conversation' | 'code';

const ROWS = 10;
const MODES: [RewindMode, string, string][] = [
  ['both', 'Restore code and conversation', 'files back to before this message; the conversation ends just before it'],
  ['conversation', 'Restore conversation only', 'files stay as they are now'],
  ['code', 'Restore code only', 'the conversation stays; files go back to before this message'],
];

/**
 * /rewind (or esc twice): pick one of your messages (newest first), then what to restore. The
 * message's text goes back into the input so it can be edited and resent.
 */
export function RewindScreen({points, onPick, onCancel}: {points: RewindPoint[]; onPick(index: number, mode: RewindMode): void; onCancel(): void}) {
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<RewindPoint | undefined>();
  const [mode, setMode] = useState(0);
  const modes = chosen && chosen.files === 0 && !chosen.whole ? MODES.filter(([m]) => m === 'conversation') : MODES;
  useInput((input, key) => {
    if (key.escape || input === 'q') return chosen ? setChosen(undefined) : onCancel();
    if (!chosen) {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(points.length - 1, c + 1));
      else if (key.return && points[cursor]) {
        setChosen(points[cursor]);
        setMode(0);
      }
    } else if (key.upArrow) setMode((m) => Math.max(0, m - 1));
    else if (key.downArrow) setMode((m) => Math.min(modes.length - 1, m + 1));
    else if (key.return) onPick(chosen.index, modes[mode]![0]);
  });
  if (!points.length) {
    return (
      <Box flexDirection="column">
        <Text>Nothing to rewind yet.</Text>
        <Text dimColor>esc close</Text>
      </Box>
    );
  }
  if (chosen) {
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          Rewind to before: <Text bold>{chosen.text.replace(/\s+/g, ' ').slice(0, 80)}</Text>
        </Text>
        <Text dimColor>
          {chosen.whole
            ? 'Restores every file changed since — including changes made by shell commands (files ignored by .gitignore are left alone).'
            : chosen.files
              ? `${chosen.files} file${chosen.files === 1 ? '' : 's'} changed since by Rein's tools (shell changes weren't snapshotted for this message)`
              : 'No file changes since by Rein’s tools'}
        </Text>
        <Box flexDirection="column" marginY={1}>
          {modes.map(([m, label, hint], i) => (
            <Clickable key={m} onHover={() => setMode(i)} onClick={() => onPick(chosen.index, m)}>
              <Text color={i === mode ? 'cyan' : undefined}>
                {i === mode ? '❯ ' : '  '}
                {label}
                <Text dimColor> — {hint}</Text>
              </Text>
            </Clickable>
          ))}
        </Box>
        <Text dimColor>enter choose · esc back</Text>
      </Box>
    );
  }
  const start = Math.max(0, Math.min(cursor - Math.floor(ROWS / 2), points.length - ROWS));
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        {start > 0 && <Text dimColor>  ↑ {start} newer</Text>}
        {points.slice(start, start + ROWS).map((p, i) => {
          const idx = start + i;
          const on = idx === cursor;
          return (
            <Clickable key={p.index} onHover={() => setCursor(idx)} onClick={() => (setChosen(p), setMode(0))}>
              <Text wrap="truncate" color={on ? 'cyan' : undefined}>
                {on ? '❯ ' : '  '}
                <Text dimColor={!on}>{age(p.at).padEnd(9)}</Text>
                <Text dimColor>{(p.files ? `${p.files} file${p.files === 1 ? '' : 's'}` : '').padEnd(9)}</Text>
                {p.text.replace(/\s+/g, ' ')}
              </Text>
            </Clickable>
          );
        })}
        {start + ROWS < points.length && <Text dimColor>  ↓ {points.length - start - ROWS} older</Text>}
      </Box>
      <Text dimColor>enter choose · ↑↓ select · esc close — files: changed since that message</Text>
    </Box>
  );
}
