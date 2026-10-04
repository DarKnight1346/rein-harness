import React, {useState} from 'react';
import {Box, Text, useInput, useWindowSize} from 'ink';
import type {PlanDecision, PresentedPlan} from '../tools/plan.js';
import {renderMarkdown} from './markdown.js';
import {Clickable} from './terminal/clicks.js';

const OPTIONS: [PlanDecision, string][] = [
  ['implement', '1 Save & implement now'],
  ['goal', '2 Save & start as a goal — tracked milestones, verified as it goes'],
  ['save', '3 Save only — start it later with /goal:plan'],
  ['revise', '4 Keep planning — I\'ll give feedback'],
];

/** The agent's plan (markdown + milestones, scrollable); every choice but "keep planning" saves it to .rein/plans/. */
export function PlanScreen({plan, width, onDecide}: {plan: PresentedPlan; width: number; onDecide(d: PlanDecision): void}) {
  const {rows} = useWindowSize();
  const body = plan.plan.replace(/^#\s+.*\n+/, '');
  const md = `# ${plan.title}\n\n${body}\n\n## Milestones\n${plan.milestones.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
  const lines = renderMarkdown(md, Math.max(20, width));
  const viewport = Math.max(4, Math.min(lines.length, rows - 14));
  const [top, setTop] = useState(0);
  const maxTop = Math.max(0, lines.length - viewport);
  useInput((input, key) => {
    if (input === '1' || key.return) onDecide('implement');
    else if (input === '2') onDecide('goal');
    else if (input === '3') onDecide('save');
    else if (input === '4' || key.escape) onDecide('revise');
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
