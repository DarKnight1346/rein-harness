import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {runtime} from '../../runtime.js';
import {shellStatusText, type Shell} from '../../tools/shells.js';
import {Clickable} from '../terminal/clicks.js';
import {InfoWindow, Window} from './Window.js';

/** Re-render on shell output/status changes, at most ~10×/s (chatty commands would otherwise flood). */
export function useShellsTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    const onChange = () => {
      if (!timer) timer = setTimeout(() => ((timer = undefined), setTick((t) => t + 1)), 100);
    };
    const shells = runtime.tools.shells;
    shells.on('change', onChange);
    const clock = setInterval(onChange, 1000); // keep "running 12s" fresh
    return () => {
      shells.off('change', onChange);
      clearInterval(clock);
      clearTimeout(timer);
    };
  }, []);
}

const statusColor = (s: Shell) => (s.status === 'running' ? 'yellow' : s.status === 'exited' && s.exitCode === 0 ? 'green' : 'red');

/** Live output of one shell: follows new lines; `k` kills it. */
export function ShellWindow({id, width, onClose}: {id: number; width: number; onClose(): void}) {
  useShellsTick();
  const shell = runtime.tools.shells.get(id);
  if (!shell) return null;
  const head = `${shell.background ? '&' : '$'} ${shell.command}`;
  const title = `${head.length > width - 30 ? head.slice(0, width - 31) + '…' : head}  ·  ${shellStatusText(shell)}`;
  const lines = [...(shell.dropped ? [`[… ${shell.dropped} earlier lines dropped]`] : []), ...shell.lines];
  return (
    <InfoWindow
      title={title}
      width={width}
      follow
      onClose={onClose}
      lines={lines.length ? lines : [shell.status === 'running' ? 'waiting for output…' : '(no output)']}
      hint={shell.status === 'running' ? 'k kill' : undefined}
      onKey={(input) => {
        if (input === 'k' && shell.status === 'running') {
          runtime.tools.shells.kill(shell.id);
          return true;
        }
      }}
    />
  );
}

/** Background shells (plus finished foreground ones); click one for its logs. */
export function ShellsWindow({width, onOpen, onClose}: {width: number; onOpen(id: number): void; onClose(): void}) {
  useShellsTick();
  const shells = runtime.tools.shells.list().sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.id - a.id);
  const [cursor, setCursor] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(shells.length - 1, c + 1));
    else if (key.return && shells[cursor]) onOpen(shells[cursor]!.id);
    else if (input === 'k' && shells[cursor]) runtime.tools.shells.kill(shells[cursor]!.id);
  });
  return (
    <Window title="Shells" width={width} onClose={onClose} footer="click/enter open logs · k kill · esc close">
      <Box flexDirection="column" marginY={1}>
        {!shells.length && <Text dimColor>No shells yet — the agent's commands appear here.</Text>}
        {shells.map((s, i) => (
          <Clickable key={s.id} onHover={() => setCursor(i)} onClick={() => onOpen(s.id)}>
            <Text wrap="truncate" color={i === cursor ? 'cyan' : undefined}>
              {i === cursor ? '❯ ' : '  '}
              <Text dimColor>#{String(s.id).padEnd(3)}</Text>
              <Text color={statusColor(s)}>{shellStatusText(s).padEnd(18)}</Text>
              <Text dimColor>{s.background ? 'bg ' : 'fg '}</Text>
              {s.command}
            </Text>
          </Clickable>
        ))}
      </Box>
    </Window>
  );
}

const LIVE_LINES = 10;

/**
 * The running foreground command's output, inline at the bottom of the chat (last 10 lines, like
 * Claude Code) instead of a popup window. `agentId` picks a subagent's commands when viewing one.
 * Click to open the full output.
 */
export function LiveShell({width, agentId, onOpen}: {width: number; agentId?: number; onOpen(id: number): void}) {
  useShellsTick();
  const shell = runtime.tools.shells
    .running({background: false})
    .filter((s) => (agentId === undefined ? !s.origin : s.origin?.agentId === agentId))
    .at(-1);
  if (!shell) return null;
  const lines = shell.lines.slice(-LIVE_LINES);
  const hidden = shell.dropped + shell.lines.length - lines.length;
  const inner = Math.max(10, width - 6);
  return (
    <Clickable onClick={() => onOpen(shell.id)}>
      <Box flexDirection="column" paddingLeft={3}>
        {hidden > 0 ? <Text dimColor>⎿ … {hidden} earlier line{hidden === 1 ? '' : 's'} (click for all)</Text> : null}
        {lines.length ? (
          lines.map((l, i) => (
            <Text key={i} dimColor wrap="truncate">
              {i === 0 && !hidden ? '⎿ ' : '  '}
              {l.slice(0, inner) || ' '}
            </Text>
          ))
        ) : (
          <Text dimColor>⎿ (no output yet)</Text>
        )}
      </Box>
    </Clickable>
  );
}
