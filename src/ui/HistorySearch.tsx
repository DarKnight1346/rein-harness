import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {TextInput} from './TextInput.js';

/** Matches for `query`, newest first: every word must appear (case-insensitive). */
export function searchHistory(entries: string[], query: string, limit = 12): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i]!;
    const low = e.toLowerCase();
    if (words.every((w) => low.includes(w)) && !out.includes(e)) out.push(e);
  }
  return out;
}

/**
 * Ctrl+R: search the messages you sent in this project (newest first). Type to filter, ↑/↓ or
 * Ctrl+R again to move, Enter puts the message in the input, Esc cancels.
 */
export function HistorySearch({entries, onPick, onCancel, width = 80}: {entries: string[]; onPick(text: string): void; onCancel(): void; width?: number}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const matches = searchHistory(entries, query);
  const pick = Math.min(index, Math.max(0, matches.length - 1));
  useInput((input, key) => {
    if (key.upArrow || (key.ctrl && input === 'r')) setIndex((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
    else if (key.downArrow) setIndex((i) => Math.max(0, i - 1));
  });
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">search: </Text>
        <TextInput
          value={query}
          onChange={(q) => {
            setQuery(q);
            setIndex(0);
          }}
          onSubmit={() => (matches[pick] !== undefined ? onPick(matches[pick]!) : onCancel())}
          onCancel={onCancel}
          placeholder="type to search your earlier messages"
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {matches.length ? (
          matches.map((m, i) => (
            <Text key={i} wrap="truncate-end" color={i === pick ? 'cyan' : undefined}>
              {i === pick ? '❯ ' : '  '}
              {oneLine(m).slice(0, width)}
            </Text>
          ))
        ) : (
          <Text dimColor>{entries.length ? 'No earlier message matches.' : 'No messages sent in this project yet.'}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>enter: put it in the input · ↑↓ / ctrl+r: move · esc: cancel</Text>
      </Box>
    </Box>
  );
}
