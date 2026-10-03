import React from 'react';
import {Box, Text} from 'ink';
import type {UsageRow} from '../accounts/usage.js';
import {PROVIDERS} from '../providers/types.js';
import {clock} from '../session/engine.js';
import {windowLabel} from '../store/usage.js';
import {accountLabel, age, relative} from './format.js';

const BAR = 20;

function bar(pct: number): {fill: string; rest: string; color: string} {
  const n = Math.max(0, Math.min(BAR, Math.round((pct / 100) * BAR)));
  return {fill: '█'.repeat(n), rest: '░'.repeat(BAR - n), color: pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green'};
}

/** Printed into the transcript (not an overlay), so any number of accounts fits without redraws. */
export function UsageReport({rows, jev}: {rows: UsageRow[]; jev: boolean}) {
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      {!rows.length && <Text dimColor>No accounts. Use /login.</Text>}
      {rows.map(({account, snapshot, cooldownUntil, error}) => (
        <Box key={account.id} flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold>{PROVIDERS[account.provider].name}</Text> {accountLabel(account)}
            {account.plan ? <Text dimColor> · {account.plan}</Text> : null}
            {cooldownUntil ? <Text color="red"> · limited until {clock(cooldownUntil)}</Text> : null}
          </Text>
          {snapshot?.windows.length ? (
            snapshot.windows.map((w) => {
              const b = bar(w.usedPct);
              return (
                <Text key={w.windowMins}>
                  {'  '}
                  {windowLabel(w.windowMins).padEnd(7)}
                  <Text color={b.color}>{b.fill}</Text>
                  <Text dimColor>{b.rest}</Text> {`${Math.round(w.usedPct)}%`.padStart(4)}
                  {w.resetsAt ? <Text dimColor>  resets {clock(w.resetsAt)} ({relative(w.resetsAt)})</Text> : null}
                </Text>
              );
            })
          ) : (
            <Text dimColor>  no usage data yet{account.provider === 'claude' ? ' (appears after the first request)' : ''}</Text>
          )}
          {snapshot && <Text dimColor>  updated {age(snapshot.at)}</Text>}
          {error && <Text color="red">  {error.slice(0, 120)}</Text>}
        </Box>
      ))}
      <Text dimColor>Jev: {jev ? 'API key set' : 'no API key (add one in /login)'} · /usage refresh re-checks Claude</Text>
    </Box>
  );
}
