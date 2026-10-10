import React, {useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {TabBar} from './TabBar.js';
import {runtime} from '../runtime.js';
import {enabledItems} from './layout.js';
import {Clickable} from './terminal/clicks.js';
import {TextInput} from './TextInput.js';
import {CONFIG_KEYS, defaultValue, formatValue, parseValue, type KeyInfo} from '../store/configKeys.js';
import {accent} from './theme.js';
import {CHOICE_TABS, GROUPS, TAB_TITLES, TABS, type ChoiceTabDef, type Tab} from './settingsTabs.js';
export {CHOICE_TABS, TAB_TITLES} from './settingsTabs.js';


/**
 * `/settings`: choose and order what the status line and sidebar show. Changes save immediately
 * and apply live (the bar and sidebar behind the window update as you toggle).
 */
export function ConfigureScreen({onClose, onChange, bare, initialTab}: {onClose(): void; onChange(): void; bare?: boolean; initialTab?: string}) {
  const [tabIndex, setTabIndex] = useState(() => Math.max(0, TAB_TITLES.findIndex((t) => t.toLowerCase() === initialTab?.toLowerCase())));
  const [cursor, setCursor] = useState(0);
  const switchTab = (i: number) => {
    setTabIndex((i + TAB_TITLES.length) % TAB_TITLES.length);
    setCursor(0);
  };
  const tabs = <TabBar titles={TAB_TITLES} active={tabIndex} onSelect={switchTab} />;
  const frame = bare ? {} : {borderStyle: 'round' as const, borderColor: accent(), paddingX: 1};
  if (tabIndex === TAB_TITLES.length - 1) return <AdvancedTab tabs={tabs} frame={frame} onClose={onClose} onChange={onChange} switchTab={(d) => switchTab(tabIndex + d)} />;
  if (tabIndex >= TABS.length && tabIndex < TABS.length + GROUPS.length) {
    const group = GROUPS[tabIndex - TABS.length]!;
    return <GroupTab key={group} defs={CHOICE_TABS.filter((d) => d.group === group)} tabs={tabs} frame={frame} onClose={onClose} onChange={onChange} switchTab={(d) => switchTab(tabIndex + d)} />;
  }
  return <LayoutTab tab={TABS[tabIndex]!} tabs={tabs} frame={frame} cursor={cursor} setCursor={setCursor} onClose={onClose} onChange={onChange} switchTab={(d) => switchTab(tabIndex + d)} />;
}

type TabProps = {tabs: React.ReactNode; frame: object; onClose(): void; onChange(): void; switchTab(dir: 1 | -1): void};

/** A group of single-choice settings: ↑↓ picks one, enter/space cycles it; its explanation and choices show below. */
function GroupTab({defs, tabs, frame, onClose, onChange, switchTab}: TabProps & {defs: ChoiceTabDef[]}) {
  const [row, setRow] = useState(0);
  const def = defs[row]!;
  const value = (d: ChoiceTabDef) => (runtime.config as Record<string, unknown>)[d.key];
  const at = (d: ChoiceTabDef) => Math.max(0, d.choices.findIndex((c) => c.value === value(d)));
  const choose = (d: ChoiceTabDef, i: number) => {
    const c = d.choices[(i + d.choices.length) % d.choices.length];
    if (c) void runtime.setConfig({[d.key]: c.value}).then(onChange);
  };
  const short = (label: string) => label.split(' — ')[0]!.replace(/\s+\(default\)$/, '');
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    else if (key.tab || key.rightArrow) switchTab(1);
    else if (key.leftArrow) switchTab(-1);
    else if (key.upArrow) setRow((r) => Math.max(0, r - 1));
    else if (key.downArrow) setRow((r) => Math.min(defs.length - 1, r + 1));
    else if (key.return || input === ' ') choose(def, at(def) + 1);
  });
  return (
    <Box flexDirection="column" {...frame}>
      {tabs}
      <Box flexDirection="column" marginY={1}>
        {defs.map((d, i) => (
          <Clickable key={d.key} onHover={() => setRow(i)} onClick={() => (i === row ? choose(d, at(d) + 1) : setRow(i))}>
            <Text color={i === row ? accent() : undefined} wrap="truncate">
              {i === row ? '❯ ' : '  '}
              {d.title.padEnd(22)}
              <Text bold={i === row}>{short(d.choices[at(d)]?.label ?? String(value(d)))}</Text>
            </Text>
          </Clickable>
        ))}
      </Box>
      <Text dimColor wrap="wrap">{def.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        {def.choices.map((c, i) => (
          <Clickable key={String(c.value)} onClick={() => choose(def, i)}>
            <Text dimColor={i !== at(def)} wrap="truncate">
              {i === at(def) ? '● ' : '○ '}
              {c.label}
            </Text>
          </Clickable>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ setting · enter/space or click to change · ←→ tab · esc close</Text>
      </Box>
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
                <Text color={i === cursor ? accent() : undefined} dimColor={!on && i !== cursor} wrap="truncate">
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

const ROWS = 14;

/**
 * Every setting in ~/.rein/config.json, so none is file-only: choices and on/off cycle with enter;
 * text, numbers, lists (comma-separated) and JSON values are edited in place.
 */
function AdvancedTab({tabs, frame, onClose, onChange, switchTab}: TabProps) {
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const info = CONFIG_KEYS[cursor]!;
  const value = (i: KeyInfo) => (runtime.config as Record<string, unknown>)[i.key];
  const save = (i: KeyInfo, v: unknown) =>
    void runtime.setConfig({[i.key]: v}).then(() => {
      setError(undefined);
      onChange();
    });
  const activate = () => {
    if (info.kind === 'boolean') return save(info, !value(info));
    if (info.kind === 'enum') return save(info, info.choices[(info.choices.indexOf(String(value(info))) + 1) % info.choices.length]);
    setEditing(value(info) === undefined ? '' : formatValue(info, value(info)));
  };
  useInput(
    (input, key) => {
      if (key.escape || input === 'q') onClose();
      else if (key.tab || key.rightArrow) switchTab(1);
      else if (key.leftArrow) switchTab(-1);
      else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(CONFIG_KEYS.length - 1, c + 1));
      else if (key.return || input === ' ') activate();
      else if (input === 'r') save(info, defaultValue(info.key));
    },
    {isActive: editing === undefined},
  );
  const first = Math.min(Math.max(0, cursor - Math.floor(ROWS / 2)), CONFIG_KEYS.length - ROWS);
  return (
    <Box flexDirection="column" {...frame}>
      {tabs}
      <Text dimColor>Every setting in ~/.rein/config.json. Same as /settings &lt;key&gt; &lt;value&gt;.</Text>
      <Box flexDirection="column" marginY={1}>
        {CONFIG_KEYS.slice(first, first + ROWS).map((i, n) => {
          const at = first + n;
          return (
            <Clickable key={i.key} onHover={() => editing === undefined && setCursor(at)} onClick={() => (setCursor(at), activate())}>
              <Text color={at === cursor ? accent() : undefined} wrap="truncate">
                {at === cursor ? '❯ ' : '  '}
                {i.key.padEnd(24)}
                <Text dimColor={at !== cursor}>{formatValue(i, value(i))}</Text>
              </Text>
            </Clickable>
          );
        })}
      </Box>
      <Text wrap="wrap">{info.description}{info.kind === 'enum' ? ` (${info.choices.join(' · ')})` : ''}</Text>
      {editing !== undefined ? (
        <Box>
          <Text color={accent()}>{info.key}: </Text>
          <TextInput
            value={editing}
            onChange={setEditing}
            onSubmit={(text) => {
              try {
                save(info, parseValue(info, text));
                setEditing(undefined);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
            onCancel={() => (setEditing(undefined), setError(undefined))}
          />
        </Box>
      ) : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>{editing !== undefined ? 'enter save · esc cancel' : 'enter edit or cycle · r reset to default · ↑↓ move · ←→ tab · esc close'}</Text>
    </Box>
  );
}
