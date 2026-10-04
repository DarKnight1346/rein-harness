import React from 'react';
import {Box, Text, useInput} from 'ink';
import type {ProjectHooks} from '../hooks.js';

type Props = {
  bare?: boolean;
  hooks: ProjectHooks;
  onTrust(): void;
  onSkip(): void;
};

/** "This project wants to run commands as hooks": shown before any project hook runs. */
export function TrustHooksPrompt({hooks, onTrust, onSkip, bare}: Props) {
  useInput((input, key) => {
    if (input === 'y' || input === '1') onTrust();
    else if (key.escape || input === 'n' || input === '2') onSkip();
  });
  const shown = hooks.commands.slice(0, 12);
  return (
    <Box flexDirection="column" {...(bare ? {} : {borderStyle: 'round' as const, borderColor: 'yellow', paddingX: 1})}>
      {!bare && <Text bold color="yellow">This project defines hooks</Text>}
      <Text>Its settings files run these commands automatically (on start, on prompts, around tool calls):</Text>
      <Box flexDirection="column" marginY={1}>
        {shown.map((c, i) => (
          <Text key={i} wrap="truncate-end">
            {'  '}
            <Text color="yellow">{c.event.padEnd(17)}</Text>
            {c.command}
            <Text dimColor> · {c.file}</Text>
          </Text>
        ))}
        {hooks.commands.length > shown.length && <Text dimColor>  … and {hooks.commands.length - shown.length} more</Text>}
      </Box>
      <Text dimColor>They run with your permissions. Only trust hooks from people you trust; any change to them asks again.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="yellow">1</Text> Trust these hooks and run them <Text dimColor>(y)</Text>
        </Text>
        <Text>
          <Text color="yellow">2</Text> Don't run them <Text dimColor>(n / esc · you'll be asked again next time)</Text>
        </Text>
      </Box>
    </Box>
  );
}
