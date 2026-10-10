import React, {useEffect, useMemo, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {runtime} from '../runtime.js';
import {CATEGORIES, installedItems, loadMarketplaces, updatesFor, type Category, type Item, type Marketplace} from '../marketplace/index.js';
import {describe, installItem, uninstallItem} from '../marketplace/actions.js';
import {TabBar} from './TabBar.js';
import {Clickable} from './terminal/clicks.js';
import {accent} from './theme.js';
import {renderMarkdown} from './markdown.js';

const ICON: Record<Category, string> = {tools: '⚒', commands: '⌘', skills: '✦', ui: '◐', feature: '✚', bundle: '▣'};
const TABS = ['All', ...CATEGORIES.map((c) => c.label), 'Installed'];
/** Catalogs are refreshed (git pull) when the window opens and they're older than this. */
const STALE_MS = 24 * 3600_000;

/**
 * /marketplace: every item of every marketplace repo, like a store. ←→ category, type to search,
 * ↑↓ item, enter installs (or updates), d uninstalls, r refreshes from the repos.
 */
export function MarketplaceScreen({width, height, onClose, log}: {width: number; height: number; onClose(): void; log(kind: 'info' | 'error', text: string): void}) {
  const [markets, setMarkets] = useState<Marketplace[] | undefined>();
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [, bump] = useState(0);

  const load = (refresh?: boolean) => {
    setBusy(refresh ? 'Refreshing the marketplaces…' : 'Loading the marketplaces…');
    void loadMarketplaces({refresh})
      .then(async (m) => {
        // A first look fetches them; after that, a day-old copy is refreshed in the background.
        setMarkets(m);
        setBusy(undefined);
        if (!refresh && m.some((x) => x.updatedAt && Date.now() - x.updatedAt > STALE_MS)) setMarkets(await loadMarketplaces({refresh: true}));
      })
      .catch((err) => {
        setBusy(undefined);
        setNote(`Couldn't load the marketplaces: ${(err as Error).message}`);
      });
  };
  useEffect(() => load(), []);

  const installed = installedItems();
  const isInstalled = (it: Item) => installed.find((i) => i.id === it.id);
  const all = useMemo(() => (markets ?? []).flatMap((m) => m.items), [markets]);
  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return all.filter((it) => {
      const t = TABS[tab]!;
      if (t === 'Installed' ? !isInstalled(it) : t !== 'All' && CATEGORIES.find((c) => c.label === t)?.id !== it.category) return false;
      return !q || `${it.name} ${it.id} ${it.description} ${it.tags.join(' ')} ${it.author ?? ''}`.toLowerCase().includes(q);
    });
  }, [all, tab, query, installed.length]);
  const sel = shown[Math.min(cursor, shown.length - 1)];
  const updates = markets ? updatesFor(markets) : [];

  const act = async (kind: 'install' | 'uninstall') => {
    if (!sel || busy) return;
    setBusy(`${kind === 'install' ? 'Installing' : 'Uninstalling'} ${sel.name}…`);
    try {
      if (kind === 'install') {
        const r = await installItem(runtime, all, sel.id);
        const text = r.lines.join('\n') + (r.restart ? '\nRestart Rein to start its MCP servers and hooks.' : '');
        setNote(text);
        log('info', text);
      } else {
        const text = await uninstallItem(runtime, sel.id);
        setNote(text);
        log('info', text);
      }
    } catch (err) {
      setNote((err as Error).message);
    }
    setBusy(undefined);
    bump((n) => n + 1);
  };

  useInput((input, key) => {
    if (key.escape) return query ? setQuery('') : onClose();
    if (key.leftArrow || key.rightArrow || key.tab) {
      setTab((t) => (t + (key.leftArrow ? -1 : 1) + TABS.length) % TABS.length);
      setCursor(0);
    } else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(shown.length - 1, c + 1));
    else if (key.return) void act('install');
    else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
    else if (key.ctrl && input === 'd') void act('uninstall');
    else if (key.ctrl && input === 'r') load(true);
    else if (input && !key.ctrl && !key.meta && input >= ' ') {
      setQuery((q) => q + input);
      setCursor(0);
    }
  });

  const listWidth = width >= 90 ? Math.floor(width * 0.42) : width;
  const rows = Math.max(4, height - 8);
  const start = Math.max(0, Math.min(cursor - Math.floor(rows / 2), shown.length - rows));
  const errors = (markets ?? []).filter((m) => m.error);
  return (
    <Box flexDirection="column" height={height}>
      <TabBar titles={TABS.map((t) => (t === 'Installed' && installed.length ? `Installed (${installed.length})` : t))} active={tab} onSelect={(i) => (setTab(i), setCursor(0))} />
      <Text>
        <Text dimColor>Search: </Text>
        {query ? <Text>{query}</Text> : <Text dimColor>type to search</Text>}
        <Text dimColor>
          {'  '}· {all.length} item{all.length === 1 ? '' : 's'} in {(markets ?? []).length} marketplace{(markets ?? []).length === 1 ? '' : 's'}
          {updates.length ? ` · ${updates.length} update${updates.length > 1 ? 's' : ''}` : ''}
        </Text>
      </Text>
      <Box flexDirection={width >= 90 ? 'row' : 'column'} flexGrow={1} marginTop={1}>
        <Box flexDirection="column" width={listWidth} flexShrink={0}>
          {!markets ? <Text dimColor>{busy ?? 'Loading…'}</Text> : !shown.length ? <Text dimColor>{query ? `Nothing matches "${query}".` : TABS[tab] === 'Installed' ? 'Nothing installed yet.' : 'Nothing here yet.'}</Text> : null}
          {shown.slice(start, start + rows).map((it, j) => {
            const i = start + j;
            const on = isInstalled(it);
            const update = updates.find((u) => u.id === it.id);
            return (
              <Clickable key={`${it.marketplace}:${it.id}`} onHover={() => setCursor(i)} onClick={() => setCursor(i)}>
                <Text color={i === cursor ? accent() : undefined} wrap="truncate">
                  {i === cursor ? '❯ ' : '  '}
                  {it.icon && [...it.icon].length <= 2 ? it.icon : ICON[it.category]} {it.name}
                  <Text dimColor> {it.version}</Text>
                  {update ? <Text color="yellow"> ↑ {update.to}</Text> : on ? <Text color="green"> ✓</Text> : null}
                </Text>
              </Clickable>
            );
          })}
        </Box>
        {sel ? (
          <Box flexDirection="column" flexGrow={1} paddingLeft={width >= 90 ? 2 : 0} marginTop={width >= 90 ? 0 : 1}>
            <Text bold wrap="truncate">
              {sel.name} <Text dimColor>{sel.version}{sel.author ? ` · by ${sel.author}` : ''}</Text>
            </Text>
            <Text dimColor wrap="truncate">
              {CATEGORIES.find((c) => c.id === sel.category)?.label} · {(markets ?? []).find((m) => m.url === sel.marketplace)?.name ?? sel.marketplace}
            </Text>
            <Box marginTop={1}>
              <Text wrap="wrap">{sel.description}</Text>
            </Box>
            {describe(sel) ? (
              <Box marginTop={1}>
                <Text wrap="wrap">
                  <Text dimColor>Adds: </Text>
                  {describe(sel).slice(2, -1)}
                </Text>
              </Box>
            ) : null}
            {sel.adds.mcp.length || sel.adds.hooks.length ? (
              <Text color="yellow" wrap="wrap">
                Runs code on your machine ({[sel.adds.mcp.length && 'MCP servers', sel.adds.hooks.length && 'hooks'].filter(Boolean).join(' and ')}): install it only from a source you trust.
              </Text>
            ) : null}
            {sel.readme ? (
              <Box marginTop={1} flexDirection="column" overflow="hidden" height={Math.max(2, rows - 8)}>
                {renderMarkdown(sel.readme.replace(/^#.*\n+/, '').slice(0, 3000), Math.max(20, width - listWidth - 4)).slice(0, Math.max(2, rows - 8)).map((l, i) => (
                  <Text key={i}>{l}</Text>
                ))}
              </Box>
            ) : null}
            <Box marginTop={1}>
              <Clickable onClick={() => void act('install')}>
                <Text color={accent()}>{isInstalled(sel) ? (updates.some((u) => u.id === sel.id) ? '[ Update ]' : '[ Reinstall ]') : '[ Install ]'}</Text>
              </Clickable>
              {isInstalled(sel) ? (
                <Clickable onClick={() => void act('uninstall')}>
                  <Text color="red">  [ Uninstall ]</Text>
                </Clickable>
              ) : null}
            </Box>
          </Box>
        ) : null}
      </Box>
      {busy && markets ? <Text color="yellow">{busy}</Text> : note ? <Text wrap="truncate">{note.split('\n')[0]}</Text> : errors.length ? <Text color="yellow" wrap="truncate">{errors.map((m) => `${m.name}: ${m.error}`).join(' · ')}</Text> : <Text> </Text>}
      <Text dimColor wrap="truncate">←→ category · type to search · ↑↓ item · enter install/update · ctrl+d uninstall · ctrl+r refresh · esc close</Text>
    </Box>
  );
}

/**
 * /marketplace update: the installed items a marketplace has a newer version of. Space ticks one
 * (or All), enter updates what's ticked; everything is ticked to start with.
 */
export function UpdatesScreen({items, updates, onDone, log}: {items: Item[]; updates: {id: string; from: string; to: string}[]; onDone(): void; log(kind: 'info' | 'error', text: string): void}) {
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState(() => new Set(updates.map((u) => u.id)));
  const [busy, setBusy] = useState(false);
  const rows = updates.length + 1; // "All", then one per item
  const toggle = (i: number) =>
    setPicked((p) => {
      if (i === 0) return p.size === updates.length ? new Set() : new Set(updates.map((u) => u.id));
      const id = updates[i - 1]!.id;
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = async () => {
    if (busy || !picked.size) return;
    setBusy(true);
    const lines: string[] = [];
    let restart = false;
    for (const u of updates.filter((x) => picked.has(x.id))) {
      try {
        const r = await installItem(runtime, items, u.id);
        lines.push(...r.lines);
        restart ||= r.restart;
      } catch (err) {
        lines.push(`${u.id}: ${(err as Error).message}`);
      }
    }
    log('info', lines.join('\n') + (restart ? '\nRestart Rein to start the updated MCP servers and hooks.' : ''));
    onDone();
  };
  useInput((input, key) => {
    if (key.escape || input === 'q') onDone();
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(rows - 1, c + 1));
    else if (input === ' ') toggle(cursor);
    else if (key.return) void run();
  });
  const name = (id: string) => items.find((i) => i.id === id)?.name ?? id;
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {updates.length} update{updates.length === 1 ? '' : 's'} for what you installed.
      </Text>
      <Box flexDirection="column" marginY={1}>
        {[{id: '*', label: 'All'}, ...updates.map((u) => ({id: u.id, label: `${name(u.id)}  `, from: u.from, to: u.to}))].map((r, i) => {
          const on = i === 0 ? picked.size === updates.length : picked.has(r.id);
          return (
            <Clickable key={r.id} onHover={() => setCursor(i)} onClick={() => toggle(i)}>
              <Text color={i === cursor ? accent() : undefined} wrap="truncate">
                {i === cursor ? '❯ ' : '  '}
                {on ? '[✓] ' : i === 0 && picked.size ? '[-] ' : '[ ] '}
                {i === 0 ? <Text bold>All</Text> : r.label}
                {'from' in r ? <Text dimColor>{(r as {from: string}).from} → </Text> : null}
                {'to' in r ? <Text color="green">{(r as {to: string}).to}</Text> : null}
              </Text>
            </Clickable>
          );
        })}
      </Box>
      <Text color={busy ? 'yellow' : undefined} dimColor={!busy}>
        {busy ? `Updating ${picked.size}…` : `space tick · enter update ${picked.size} · esc cancel`}
      </Text>
    </Box>
  );
}
