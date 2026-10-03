import React from 'react';
import {Box, Text, useInput} from 'ink';
import {accountName, hidingIdentity} from './privacy.js';
import type {AccountRow} from '../accounts/service.js';
import {PROVIDERS} from '../providers/types.js';

type Props = {
  bare?: boolean;
  rows: AccountRow[];
  onImport(): void;
  onSkip(): void;
};

export function ImportPrompt({rows, onImport, onSkip, bare}: Props) {
  useInput((input, key) => {
    if (key.return || input === 'y') onImport();
    else if (key.escape || input === 'n') onSkip();
  });
  return (
    <Box flexDirection="column" {...(bare ? {} : {borderStyle: 'round' as const, borderColor: 'cyan', paddingX: 1})}>
      {!bare && <Text bold>Found existing logins</Text>}
      <Box flexDirection="column" marginY={1}>
        {rows.map(({account, status}) => (
          <Text key={account.id}>
            {'  '}
            <Text bold>{PROVIDERS[account.provider].name.padEnd(7)}</Text>
            {status.loggedIn ? (hidingIdentity() ? accountName(account, rows.map((r) => r.account)) : (status.email ?? 'unknown email')) : ''}
            {status.loggedIn && status.plan ? <Text dimColor> · {status.plan}</Text> : null}
          </Text>
        ))}
      </Box>
      <Text dimColor>Rein uses them in place (nothing is copied) and never logs them out.</Text>
      <Text>Import? (Y/n)</Text>
    </Box>
  );
}
