import {Box, Text, useApp, useInput} from 'ink';
import React, {useEffect, useState} from 'react';
import {describeLive, listLive, sendTo, type Live} from '../host/live.js';

/**
 * `rein sessions`: every running Rein on this machine, across repos, refreshed every second.
 * ↑↓ pick one · enter attaches (background sessions) · m sends it a message · k stops it · q quits.
 */
export type DashboardChoice = {attach: string} | {quit: true};

export function SessionsDashboard({onDone}: {onDone(c: DashboardChoice): void}) {
  const {exit} = useApp();
  const [list, setList] = useState<Live[]>(() => listLive());
  const [row, setRow] = useState(0);
  const [composing, setComposing] = useState<string | undefined>();
  const [confirmKill, setConfirmKill] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    const t = setInterval(() => setList(listLive()), 1000);
    return () => clearInterval(t);
  }, []);
  const cur = list[Math.min(row, list.length - 1)];
  const done = (c: DashboardChoice) => {
    onDone(c);
    exit();
  };
  useInput((input, key) => {
    if (composing !== undefined) {
      if (key.escape) setComposing(undefined);
      else if (key.return) {
        if (cur && composing.trim()) {
          try {
            sendTo(cur.pid, composing.trim());
            setNote(`Sent to ${cur.pid}.`);
          } catch (err) {
            setNote((err as Error).message);
          }
        }
        setComposing(undefined);
      } else if (key.backspace || key.delete) setComposing((c) => (c ?? '').slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setComposing((c) => (c ?? '') + input);
      return;
    }
    if (confirmKill) {
      setConfirmKill(false);
      if (input === 'y' && cur) {
        try {
          process.kill(cur.pid);
          setNote(`Stopped ${cur.pid}.`);
        } catch (err) {
          setNote((err as Error).message);
        }
      }
      return;
    }
    if (input === 'q' || key.escape) done({quit: true});
    else if (key.upArrow) setRow((r) => Math.max(0, r - 1));
    else if (key.downArrow) setRow((r) => Math.min(list.length - 1, r + 1));
    else if (key.return && cur) {
      if (cur.host) done({attach: cur.host});
      else setNote('That one runs in its own terminal; only background sessions (rein --background) can be attached. m sends it a message.');
    } else if (input === 'm' && cur) {
      setNote('');
      setComposing('');
    } else if (input === 'k' && cur) setConfirmKill(true);
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Rein sessions on this machine</Text>
      <Box flexDirection="column" marginY={1}>
        {list.length ? (
          list.map((l) => (
            <Text key={l.pid} color={l === cur ? 'cyan' : undefined} wrap="truncate">
              {l === cur ? '❯ ' : '  '}
              <Text color={l.state === 'waiting' ? 'yellow' : l.state === 'working' ? 'green' : undefined}>{describeLive(l)}</Text>
              <Text dimColor>{`  pid ${l.pid}`}</Text>
            </Text>
          ))
        ) : (
          <Text dimColor>No Rein is running. rein --background starts one that this screen can attach to.</Text>
        )}
      </Box>
      {composing !== undefined ? (
        <Text>
          <Text color="cyan">Message to {cur?.pid}: </Text>
          {composing}
          <Text inverse> </Text>
        </Text>
      ) : confirmKill ? (
        <Text color="yellow">Stop Rein {cur?.pid} ({cur?.cwd})? y to stop, any other key to keep it</Text>
      ) : (
        <Text dimColor>↑↓ pick · enter attach · m message · k stop · q quit</Text>
      )}
      {note ? <Text dimColor>{note}</Text> : null}
    </Box>
  );
}
