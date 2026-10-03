import React, {useState} from 'react';
import {Box, Text, useInput, useWindowSize} from 'ink';
import type {PlanDecision} from '../tools/plan.js';
import {renderMarkdown} from './markdown.js';
import {Clickable} from './terminal/clicks.js';

const OPTIONS: [PlanDecision, string][] = [
  ['approve', '1 Approve — start (changes still ask as usual)'],
  ['approve-all', '2 Approve & allow all changes this session'],
  ['revise', '3 Keep planning — I\'ll give feedback'],
];

/** The agent's plan (markdown, scrollable) with approve / approve-all / keep-planning. */
export function PlanScreen({plan, width, onDecide}: {plan: string; width: number; onDecide(d: PlanDecision): void}) {
  const {rows} = useWindowSize();
  const lines = renderMarkdown(plan, Math.max(20, width));
  const viewport = Math.max(4, Math.min(lines.length, rows - 14));
  const [top, setTop] = useState(0);
  const maxTop = Math.max(0, lines.length - viewport);
  useInput((input, key) => {
    if (input === '1' || key.return) onDecide('approve');
    else if (input === '2') onDecide('approve-all');
    else if (input === '3' || key.escape) onDecide('revise');
    else if (key.upArrow) setTop((t) => Math.max(0, t - 1));
    else if (key.downArrow) setTop((t) => Math.min(maxTop, t + 1));
    else if (key.pageUp) setTop((t) => Math.max(0, t - viewport));
    else if (key.pageDown) setTop((t) => Math.min(maxTop, t + viewport));
  });
  return (
    <Box flexDirection="column">
      <Clickable onWheel={(dir) => setTop((t) => Math.max(0, Math.min(maxTop, t + dir * 3)))}>
        <Box flexDirection="column" height={viewport} overflow="hidden">
          {lines.slice(top, top + viewport).map((l, i) => (
            <Text key={i} wrap="truncate">
              {l || ' '}
            </Text>
          ))}
        </Box>
      </Clickable>
      {lines.length > viewport && <Text dimColor>{`${top + 1}–${Math.min(lines.length, top + viewport)} of ${lines.length} · ↑↓ scroll`}</Text>}
      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map(([d, label]) => (
          <Clickable key={d} onClick={() => onDecide(d)}>
            <Text color={d === 'revise' ? 'yellow' : 'green'}>[{label}]</Text>
          </Clickable>
        ))}
      </Box>
    </Box>
  );
}
