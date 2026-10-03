import React, {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {approveProjectServer} from '../mcp/config.js';
import {runtime} from '../runtime.js';
import {Clickable} from './terminal/clicks.js';

const COLOR = {connected: 'green', connecting: 'yellow', failed: 'red', 'needs-approval': 'yellow'} as const;
const SOURCE = {project: '.mcp.json', rein: '~/.rein/mcp.json', claude: '~/.claude.json'} as Record<string, string>;

/** /mcp: servers with status and tool count; enter approves a project server or reconnects. */
export function McpScreen({onClose}: {onClose(): void}) {
  const [, setTick] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | undefined>();
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    runtime.mcp.on('change', on);
    return () => void runtime.mcp.off('change', on);
  }, []);
  const servers = runtime.mcp.list();
  const act = async (i: number) => {
    const s = servers[i];
    if (!s || busy) return;
    setBusy(s.name);
    if (s.status === 'needs-approval') {
      approveProjectServer(process.cwd(), s.name);
      await runtime.mcp.start();
    } else await runtime.mcp.reconnect(s.name);
    setBusy(undefined);
  };
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(servers.length - 1, c + 1));
    else if (key.return) void act(cursor);
  });
  if (!servers.length) {
    return (
      <Box flexDirection="column">
        <Text>No MCP servers configured.</Text>
        <Text dimColor>Add them to .mcp.json in the project, ~/.rein/mcp.json, or with `claude mcp add` (Claude Code's format: {'{"mcpServers": {"name": {"command": "…", "args": []}}}'}).</Text>
        <Text dimColor>esc close</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {servers.map((s, i) => (
        <Clickable key={s.name} onHover={() => setCursor(i)} onClick={() => void act(i)}>
          <Text wrap="truncate" color={i === cursor ? 'cyan' : undefined}>
            {i === cursor ? '❯ ' : '  '}
            <Text color={COLOR[s.status]}>●</Text> <Text bold>{s.name.padEnd(16)}</Text>
            {busy === s.name ? 'working…' : s.status === 'connected' ? `${s.tools} tool${s.tools === 1 ? '' : 's'}` : s.status}
            <Text dimColor>
              {' '}
              · {s.transport} · {SOURCE[s.source] ?? s.source}
              {s.error ? ` · ${s.error.slice(0, 80)}` : ''}
            </Text>
          </Text>
        </Clickable>
      ))}
      <Box marginTop={1}>
        <Text dimColor>enter: {servers[cursor]?.status === 'needs-approval' ? 'approve this project server (runs its command)' : 'reconnect'} · esc close</Text>
      </Box>
    </Box>
  );
}
