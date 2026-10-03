import React from 'react';
import {Box, Text, useInput} from 'ink';
import type {ApprovalDecision, ApprovalRequest} from '../tools/host.js';
import {Clickable} from './terminal/clicks.js';
import {redact} from './privacy.js';

const MAX_PREVIEW_LINES = 14;

/**
 * Ask before a file change or shell command runs. 1/y = allow once, 2/a = allow file changes and
 * commands for the rest of this session, 3/n/esc = deny (the model is told to ask how to proceed).
 */
export function ApprovalPrompt({req, onDecide, bare}: {req: ApprovalRequest; onDecide(d: ApprovalDecision): void; bare?: boolean}) {
  useInput((input, key) => {
    if (input === '1' || input === 'y' || key.return) onDecide('once');
    else if ((input === '2' || input === 'a') && !req.sensitive) onDecide('session');
    else if (input === '3' || input === 'n' || key.escape) onDecide('deny');
  });
  const lines = req.preview ? req.preview.split('\n') : [];
  const shown = lines.slice(0, MAX_PREVIEW_LINES);
  const outside = req.outside?.length ? req.outside : undefined;
  // Outside the project: "this session" means reads anywhere, or this folder for changes.
  // Credentials/secrets only ever get a one-time yes.
  const sessionLabel = outside
    ? req.tool.mutating
      ? `2 Allow ${outside.length === 1 ? 'this folder' : 'these folders'} this session`
      : '2 Allow reads outside the project this session'
    : '2 Allow all changes & commands this session';
  const options: [ApprovalDecision, string][] = [['once', '1 Allow'], ...(req.sensitive ? [] : [['session', sessionLabel] as [ApprovalDecision, string]]), ['deny', '3 Deny']];
  return (
    <Box flexDirection="column" {...(bare ? {} : {borderStyle: 'round' as const, borderColor: 'yellow', paddingX: 1})}>
      <Text>
        {req.origin ? <Text color="magenta">Subagent {req.origin.name}</Text> : 'Rein'} wants to <Text bold color="yellow">{req.tool.label}</Text> <Text bold>{redact(req.summary)}</Text>
      </Text>
      {outside ? (
        <Text color={req.sensitive ? 'red' : 'yellow'}>
          {req.sensitive ? '⚠ Sensitive location (credentials/secrets) outside the project: ' : 'Outside the project: '}
          {outside.map((p) => redact(p)).join(', ')}
        </Text>
      ) : null}
      {shown.length ? (
        <Box flexDirection="column" marginY={1}>
          {shown.map((l, i) => (
            <Text key={i} wrap="truncate" color={l.startsWith('+ ') ? 'green' : l.startsWith('- ') ? 'red' : /^(background )?\$ /.test(l) ? 'yellow' : undefined} dimColor={!/^([+-] |(background )?\$ )/.test(l)}>
              {redact(l) || ' '}
            </Text>
          ))}
          {lines.length > shown.length && <Text dimColor>… {lines.length - shown.length} more lines</Text>}
        </Box>
      ) : (
        <Text> </Text>
      )}
      <Box>
        {options.map(([d, label]) => (
          <Box key={d} marginRight={2}>
            <Clickable onClick={() => onDecide(d)}>
              <Text color={d === 'deny' ? 'red' : d === 'once' ? 'green' : 'cyan'}>[{label}]</Text>
            </Clickable>
          </Box>
        ))}
      </Box>
      <Text dimColor>{req.sensitive ? 'enter/1 allow once · esc/3 deny' : 'enter/1 allow · 2 allow session · esc/3 deny'}</Text>
    </Box>
  );
}
