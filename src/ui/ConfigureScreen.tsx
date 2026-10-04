import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {TabBar} from './TabBar.js';
import {runtime} from '../runtime.js';
import {DEFAULT_SIDEBAR, DEFAULT_STATUS, enabledItems, SIDEBAR_ITEMS, STATUS_ITEMS, type LayoutItem} from './layout.js';
import {Clickable} from './terminal/clicks.js';

type Tab = {id: 'status' | 'sidebar'; title: string; items: LayoutItem[]; defaults: string[]; key: 'statusLine' | 'sidebarSections'};
const TABS: Tab[] = [
  {id: 'status', title: 'Status line', items: STATUS_ITEMS, defaults: DEFAULT_STATUS, key: 'statusLine'},
  {id: 'sidebar', title: 'Sidebar', items: SIDEBAR_ITEMS, defaults: DEFAULT_SIDEBAR, key: 'sidebarSections'},
];
type Choice = {value: string | number | boolean; label: string};
type ChoiceTabDef = {title: string; key: 'autoCompactPct' | 'toolApproval' | 'shellMaxMinutes' | 'subagentLimit' | 'goalMaxRounds' | 'hidePersonalInfo' | 'autoUpdate' | 'loadBalancing' | 'notifications'; description: string; choices: Choice[]};
const CHOICE_TABS: ChoiceTabDef[] = [
  {
    title: 'Approvals',
    key: 'toolApproval',
    description: 'What happens when the agent wants to write, edit or delete a file. Reads and searches never ask.',
    choices: [
      {value: 'ask', label: 'Ask — confirm every file change  (default)'},
      {value: 'auto', label: 'Auto — the decision model approves changes that clearly match your request; asks you otherwise'},
      {value: 'bypass', label: 'Bypass — allow every file change without asking'},
    ],
  },
  {
    title: 'Shell',
    key: 'shellMaxMinutes',
    description: 'Longest a foreground command may run. The agent picks a timeout per command (2 min by default) up to this cap. Background processes have no limit.',
    choices: [10, 30, 60, 120, 240, 480, 0].map((v) => ({
      value: v,
      label: v === 0 ? 'No limit' : `${v < 60 ? `${v} minutes` : `${v / 60} hour${v === 60 ? '' : 's'}`}${v === 120 ? '  (default)' : ''}`,
    })),
  },
  {
    title: 'Subagents',
    key: 'subagentLimit',
    description: 'How many subagents may run at once (the agent is told the limit and waits or does the work itself when it is reached).',
    choices: [1, 2, 3, 5, 10, 20].map((v) => ({value: v, label: `${v} at a time${v === 10 ? '  (default)' : ''}`})),
  },
  {
    title: 'Goals',
    key: 'goalMaxRounds',
    description: 'How many automatic continuations a /goal may take before it pauses itself (/goal resume continues).',
    choices: [0, 10, 25, 50, 100, 250].map((v) => ({value: v, label: v === 0 ? 'Unlimited  (default)' : `${v} continuations`})),
  },
  {
    title: 'Load balancing',
    key: 'loadBalancing',
    description: 'How Rein spreads work across your subscriptions. Balanced moves a conversation to the account with the most room only when its prompt cache has gone cold (idle 5+ min) or the account is near its limit; new chats and subagents start on the least-used account.',
    choices: [
      {value: 'balanced', label: 'Balanced  (default) — cache-aware'},
      {value: 'sticky', label: 'Sticky — stay on one account until it hits a limit'},
    ],
  },
  {
    title: 'Notifications',
    key: 'notifications',
    description: 'Get your attention when Rein needs you (an approval, a question, a plan to review) or finishes a task that took a while.',
    choices: [
      {value: 'terminal', label: 'Terminal — bell + terminal notification (iTerm2, WezTerm, kitty, Ghostty…)  (default)'},
      {value: 'system', label: 'Desktop — also a macOS / Linux desktop notification'},
      {value: 'off', label: 'Off'},
    ],
  },
  {
    title: 'Updates',
    key: 'autoUpdate',
    description: 'On launch, check npm for a newer Rein and install it in the background (takes effect next start). /update or rein --update also updates the claude and codex CLIs.',
    choices: [
      {value: true, label: 'Auto-update Rein  (default)'},
      {value: false, label: 'Only when I run /update'},
    ],
  },
  {
    title: 'Privacy',
    key: 'hidePersonalInfo',
    description: 'Hide your emails and username in the UI so screenshots are safe to share. Accounts show as "Claude Account 1", "Codex Account 1"; your home folder shows as ~.',
    choices: [
      {value: true, label: 'Hide personal info  (default)'},
      {value: false, label: 'Show emails and paths'},
    ],
  },
  {
    title: 'Compaction',
    key: 'autoCompactPct',
    description: "Summarize older messages automatically when the context reaches this share of the model's window.",
    choices: [0, 50, 60, 70, 80, 90, 95].map((v) => ({
      value: v,
      label: v === 0 ? 'Off (only /compact, or when a model rejects a full context)' : `At ${v}% of the context window${v === 80 ? '  (default)' : ''}`,
    })),
  },
];
const TAB_TITLES = [...TABS.map((t) => t.title), ...CHOICE_TABS.map((t) => t.title)];

/**
 * `/configure`: choose and order what the status line and sidebar show. Changes save immediately
 * and apply live (the bar and sidebar behind the window update as you toggle).
 */
export function ConfigureScreen({onClose, onChange, bare}: {onClose(): void; onChange(): void; bare?: boolean}) {
  const [tabIndex, setTabIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const switchTab = (i: number) => {
    setTabIndex((i + TAB_TITLES.length) % TAB_TITLES.length);
    setCursor(0);
  };
  const tabs = <TabBar titles={TAB_TITLES} active={tabIndex} onSelect={switchTab} />;
  const frame = bare ? {} : {borderStyle: 'round' as const, borderColor: 'cyan', paddingX: 1};
  if (tabIndex >= TABS.length) {
    const def = CHOICE_TABS[tabIndex - TABS.length]!;
    return <ChoiceTab key={def.key} def={def} tabs={tabs} frame={frame} onClose={onClose} onChange={onChange} switchTab={(d) => switchTab(tabIndex + d)} />;
  }
  return <LayoutTab tab={TABS[tabIndex]!} tabs={tabs} frame={frame} cursor={cursor} setCursor={setCursor} onClose={onClose} onChange={onChange} switchTab={(d) => switchTab(tabIndex + d)} />;
}

type TabProps = {tabs: React.ReactNode; frame: object; onClose(): void; onChange(): void; switchTab(dir: 1 | -1): void};

/** Single-choice setting (approvals, auto-compact threshold). */
function ChoiceTab({def, tabs, frame, onClose, onChange, switchTab}: TabProps & {def: ChoiceTabDef}) {
  const current = runtime.config[def.key];
  const [cursor, setCursor] = useState(Math.max(0, def.choices.findIndex((c) => c.value === current)));
  const choose = (i: number) => {
    const c = def.choices[i];
    if (c) void runtime.setConfig({[def.key]: c.value}).then(onChange);
  };
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    else if (key.tab || key.rightArrow) switchTab(1);
    else if (key.leftArrow) switchTab(-1);
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(def.choices.length - 1, c + 1));
    else if (key.return || input === ' ') choose(cursor);
  });
  return (
    <Box flexDirection="column" {...frame}>
      {tabs}
      <Text dimColor>{def.description}</Text>
      <Box flexDirection="column" marginY={1}>
        {def.choices.map((c, i) => (
          <Clickable key={String(c.value)} onHover={() => setCursor(i)} onClick={() => choose(i)}>
            <Text color={i === cursor ? 'cyan' : undefined} wrap="truncate">
              {i === cursor ? '❯ ' : '  '}
              {c.value === current ? '● ' : '○ '}
              {c.label}
            </Text>
          </Clickable>
        ))}
      </Box>
      <Text dimColor>click/enter choose · ←→ tab · esc close</Text>
    </Box>
  );
}

function LayoutTab({tab, tabs, frame, cursor, setCursor, onClose, onChange, switchTab}: TabProps & {tab: Tab; cursor: number; setCursor: React.Dispatch<React.SetStateAction<number>>}) {
  const enabled = enabledItems(tab.id, runtime.config);
  // Enabled items first (in their order), then the rest (in default order).
  const rows = [...enabled.map((id) => tab.items.find((i) => i.id === id)!), ...tab.items.filter((i) => !enabled.includes(i.id))];

  const save = (next: string[], keepCursorOn?: string) => {
    void runtime.setConfig({[tab.key]: next}).then(() => {
      onChange();
      if (keepCursorOn) {
        const order = [...next, ...tab.items.map((i) => i.id).filter((id) => !next.includes(id))];
        setCursor(Math.max(0, order.indexOf(keepCursorOn)));
      }
    });
  };
  const toggle = (idx: number) => {
    const item = rows[idx];
    if (!item) return;
    save(enabled.includes(item.id) ? enabled.filter((id) => id !== item.id) : [...enabled, item.id], item.id);
  };
  const move = (idx: number, dir: -1 | 1) => {
    const item = rows[idx];
    const at = item ? enabled.indexOf(item.id) : -1;
    const to = at + dir;
    if (at < 0 || to < 0 || to >= enabled.length) return;
    const next = [...enabled];
    [next[at], next[to]] = [next[to]!, next[at]!];
    save(next, item!.id);
  };
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    else if (key.tab || key.rightArrow) switchTab(1);
    else if (key.leftArrow) switchTab(-1);
    else if (key.upArrow && key.shift) move(cursor, -1);
    else if (key.downArrow && key.shift) move(cursor, 1);
    else if (input === '[') move(cursor, -1);
    else if (input === ']') move(cursor, 1);
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(rows.length - 1, c + 1));
    else if (key.return || input === ' ') toggle(cursor);
    else if (input === 'r') save(tab.defaults);
  });

  return (
    <Box flexDirection="column" {...frame}>
      {tabs}
      <Text dimColor>{tab.id === 'status' ? 'Segments of the top status line, left to right.' : 'Sidebar sections, top to bottom (fullscreen).'}</Text>
      <Box flexDirection="column" marginY={1}>
        {rows.map((item, i) => {
          const on = enabled.includes(item.id);
          const pos = enabled.indexOf(item.id);
          return (
            <Box key={item.id}>
              <Clickable onHover={() => setCursor(i)} onClick={() => toggle(i)}>
                <Text color={i === cursor ? 'cyan' : undefined} dimColor={!on && i !== cursor} wrap="truncate">
                  {i === cursor ? '❯ ' : '  '}
                  {on ? '[✓] ' : '[ ] '}
                  {item.label.padEnd(16)}
                  <Text dimColor>{item.description}</Text>
                </Text>
              </Clickable>
              {on ? (
                <>
                  <Box flexGrow={1} />
                  <Clickable onClick={() => move(i, -1)}>
                    <Text dimColor={pos === 0} color={pos === 0 ? undefined : 'gray'}> ▲</Text>
                  </Clickable>
                  <Clickable onClick={() => move(i, 1)}>
                    <Text dimColor={pos === enabled.length - 1} color={pos === enabled.length - 1 ? undefined : 'gray'}> ▼</Text>
                  </Clickable>
                </>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Text dimColor>click/space toggle · ▲▼ or shift+↑↓ / [ ] reorder · r reset · ←→ tab · esc close</Text>
    </Box>
  );
}
