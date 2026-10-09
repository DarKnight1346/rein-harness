import React from 'react';
import {Box, Text} from 'ink';
import type {ContextReport} from '../session/context.js';

const COLS = 20;
const ROWS = 8; // 160 cells, room for every legend line
const COLOR = {system: 'gray', tools: 'yellow', summary: 'magenta', messages: 'cyan', calls: 'green', other: 'blue'} as const;

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(1)}%`;

/** `/context`: a usage grid like Claude Code's, one cell per 1% of the model's window. */
export function ContextView({report}: {report: ContextReport}) {
  const {window, categories, used} = report;
  // Fill cells in category order; any non-zero category gets at least one cell.
  const cells: (keyof typeof COLOR | 'free')[] = [];
  for (const c of categories) {
    const n = c.tokens ? Math.max(1, Math.round((c.tokens / window) * COLS * ROWS)) : 0;
    for (let i = 0; i < n && cells.length < COLS * ROWS; i++) cells.push(c.key);
  }
  while (cells.length < COLS * ROWS) cells.push('free');

  const legend = [
    <Text key="h" bold>
      {report.modelLabel} · {k(report.measured ?? used)}/{k(window)} tokens ({pct(report.measured ?? used, window)}
      {report.measured !== undefined ? ', measured' : ', est.'})
    </Text>,
    ...categories.map((c) => (
      <Text key={c.key}>
        <Text color={COLOR[c.key]}>⛁</Text> {c.label}: <Text bold>{k(c.tokens)}</Text>
        <Text dimColor> ({pct(c.tokens, window)})</Text>
      </Text>
    )),
    <Text key="free">
      <Text dimColor>⛶</Text> Free space: {k(Math.max(0, window - used))}
      <Text dimColor> ({pct(Math.max(0, window - used), window)})</Text>
    </Text>,
  ];

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      <Box>
        <Box flexDirection="column" marginRight={3}>
          {Array.from({length: ROWS}, (_, r) => (
            <Text key={r}>
              {cells.slice(r * COLS, (r + 1) * COLS).map((c, i) =>
                c === 'free' ? (
                  <Text key={i} dimColor>
                    ⛶{' '}
                  </Text>
                ) : (
                  <Text key={i} color={COLOR[c]}>
                    ⛁{' '}
                  </Text>
                ),
              )}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">{legend}</Box>
      </Box>
      <Text dimColor>
        {report.messageCount} messages
        {report.summarizedCount ? ` · ${report.summarizedCount} folded into the summary` : ''}
        {report.measured !== undefined ? ` · last request measured ${k(report.measured)} input tokens` : ' · estimates (~4 chars/token)'}
        {report.autoCompactAt ? ` · auto-compacts at ${k(report.autoCompactAt)}` : ' · auto-compact off'}
      </Text>
      {!!report.largest?.length && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Largest items</Text>
          {report.largest.map((i, n) => (
            <Text key={n} wrap="truncate">
              {k(i.tokens).padStart(6)} <Text dimColor>{i.what}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
