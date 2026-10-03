import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {SessionInfo} from '../session/transcript.js';
import {age} from './format.js';
import {Clickable} from './terminal/clicks.js';

const ROWS = 12;

/** Pick a saved conversation to continue (newest first). Esc starts a new one. */
export function ResumeScreen({sessions, onPick, onCancel, bare}: {sessions: SessionInfo[]; onPick(id: string): void; onCancel(): void; bare?: boolean}) {
  const [cursor, setCursor] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === 'q') onCancel();
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(sessions.length - 1, c + 1));
    else if (key.pageUp) setCursor((c) => Math.max(0, c - ROWS));
    else if (key.pageDown) setCursor((c) => Math.min(sessions.length - 1, c + ROWS));
    else if (key.return && sessions[cursor]) onPick(sessions[cursor]!.id);
  });
  const start = Math.max(0, Math.min(cursor - Math.floor(ROWS / 2), sessions.length - ROWS));
  const visible = sessions.slice(start, start + ROWS);
  const wheel = (dir: 1 | -1) => setCursor((c) => Math.max(0, Math.min(sessions.length - 1, c + dir)));
  return (
    <Box flexDirection="column" {...(bare ? {} : {borderStyle: 'round' as const, borderColor: 'cyan', paddingX: 1})}>
      {!bare && <Text bold>Continue a conversation</Text>}
      <Box flexDirection="column" marginY={1}>
        {start > 0 && <Text dimColor>  ↑ {start} newer</Text>}
        {visible.map((s, i) => {
          const idx = start + i;
          const on = idx === cursor;
          return (
            <Clickable key={s.id} onHover={() => setCursor(idx)} onClick={() => onPick(s.id)} onWheel={wheel}>
              <Text wrap="truncate" color={on ? 'cyan' : undefined}>
                {on ? '❯ ' : '  '}
                <Text dimColor={!on}>{age(s.updatedAt).padEnd(9)}</Text>
                <Text dimColor>{`${s.messages} msgs`.padEnd(9)}</Text>
                {s.title}
                <Text dimColor>
                  {'  '}
                  {s.models.join(', ')}
                  {s.summarized ? ' · summarized' : ''}
                </Text>
              </Text>
            </Clickable>
          );
        })}
        {start + ROWS < sessions.length && <Text dimColor>  ↓ {sessions.length - start - ROWS} older</Text>}
      </Box>
      <Text dimColor>click/enter continue · ↑↓ select · esc start a new conversation</Text>
    </Box>
  );
}
