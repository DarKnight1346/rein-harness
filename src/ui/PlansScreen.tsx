import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {progress, type SavedPlan} from '../plans/store.js';
import {age} from './format.js';
import {Clickable} from './terminal/clicks.js';

/** /goal:plan: pick an unfinished saved plan to start as a goal, or start planning a new one. */
export function PlansScreen({plans, onPick, onNew, onCancel}: {plans: SavedPlan[]; onPick(p: SavedPlan): void; onNew(): void; onCancel(): void}) {
  const [cursor, setCursor] = useState(0);
  const rows = plans.length + 1; // + "start a new plan"
  const choose = (i: number) => (i < plans.length ? onPick(plans[i]!) : onNew());
  useInput((input, key) => {
    if (key.escape || input === 'q') onCancel();
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(rows - 1, c + 1));
    else if (key.return) choose(cursor);
  });
  return (
    <Box flexDirection="column">
      {plans.length ? <Text dimColor>Unfinished plans in .rein/plans/ (newest first):</Text> : <Text dimColor>No unfinished plans in .rein/plans/ yet.</Text>}
      <Box flexDirection="column" marginY={1}>
        {plans.map((p, i) => {
          const g = progress(p);
          return (
            <Clickable key={p.file} onHover={() => setCursor(i)} onClick={() => onPick(p)}>
              <Text wrap="truncate" color={i === cursor ? 'cyan' : undefined}>
                {i === cursor ? '❯ ' : '  '}
                {p.title}
                <Text dimColor>
                  {' '}
                  · {g.done}/{g.total} milestones · {age(p.savedAt)}
                </Text>
              </Text>
            </Clickable>
          );
        })}
        <Clickable onHover={() => setCursor(plans.length)} onClick={onNew}>
          <Text color={cursor === plans.length ? 'cyan' : 'green'}>{cursor === plans.length ? '❯ ' : '  '}✎ Start a new plan</Text>
        </Clickable>
      </Box>
      <Text dimColor>enter start as a goal · ↑↓ select · esc close</Text>
    </Box>
  );
}
