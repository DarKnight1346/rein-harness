import React, {useEffect, useState} from 'react';
import {Text} from 'ink';
import {runtime} from '../runtime.js';
import {usageStore} from '../store/usage.js';
import {enabledItems, statusInfo} from './layout.js';
import {useShellsTick} from './fullscreen/Shells.js';

/** Classic renderer's status line: the configured segments as plain text (`/configure`). */
export function StatusBar({tick}: {tick: number}) {
  const [, setUsageTick] = useState(0);
  useEffect(() => usageStore.subscribe(() => setUsageTick((t) => t + 1)), []);
  void tick;
  useShellsTick();
  const info = statusInfo();
  const background = runtime.tools.shells.running({background: true}).length;
  const parts = enabledItems('status', runtime.config).flatMap((id) => {
    switch (id) {
      case 'model':
        return [info.model];
      case 'account':
        return [info.account];
      case 'usage':
        return info.usage ? [info.usage] : [];
      case 'context':
        return [`ctx ${info.context}%`];
      case 'decider':
        return [`decides: ${info.decider}`];
      case 'messages':
        return [`${info.messages} msgs`];
      case 'approvals':
        return [`edits: ${info.approvals}`];
      case 'advisor':
        return [`advisor: ${info.advisor}`];
      default:
        return []; // sidebarToggle: fullscreen only
    }
  });
  return (
    <Text dimColor>
      {'  '}rein{parts.length ? ` · ${parts.join(' · ')}` : ''}
      {background ? <Text color="yellow"> · ● {background} background (/shells)</Text> : null}
      {runtime.goals.goal ? <Text color="cyan"> · ◎ goal {runtime.goals.goal.status}</Text> : null}
    </Text>
  );
}
