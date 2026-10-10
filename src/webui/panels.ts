import {PROVIDERS, refKey} from '../providers/types.js';
import {formatUsd} from '../providers/prices.js';
import {runtime} from '../runtime.js';
import {catalog, toRef} from '../router/catalog.js';
import {defaultRef} from '../router/index.js';
import {extensions} from '../extensions/index.js';
import {progress} from '../plans/store.js';
import {CONFIG_KEYS, defaultValue, formatValue, parseValue} from '../store/configKeys.js';
import {getJevKey} from '../store/secrets.js';
import {usageStore, windowLabel} from '../store/usage.js';
import {isMilestoneCopy, todoLine} from '../tools/todo.js';
import {accountLabel} from '../ui/format.js';
import {contextPct, enabledItems, SIDEBAR_ITEMS, STATUS_ITEMS, statusInfo} from '../ui/layout.js';
import {currentValue, describe, effortOptions, optionsFor, SECTIONS} from '../ui/modelOptions.js';
import {CHOICE_TABS, GROUPS, TABS} from '../ui/settingsTabs.js';

/**
 * What the web UI draws around a chat (the status line, the sidebar) and the windows it opens for
 * /settings and /model, as plain data from the same sources as the terminal UI's: the layout
 * settings, statusInfo, the tab and option definitions. No Ink here, so the worker can load it.
 */

const safe = <T>(f: () => T, fallback: T): T => {
  try {
    return f();
  } catch {
    return fallback;
  }
};

/** The status line: the segments you turned on (/settings → Status line), then marketplace items' segments. */
export function statusView(): {id: string; label: string; value: string; command?: string; tone?: string}[] {
  const info = statusInfo();
  const label = Object.fromEntries(STATUS_ITEMS.map((i) => [i.id, i.label]));
  const command: Record<string, string> = {model: '/model', account: '/usage', usage: '/usage', context: '/context', approvals: '/settings Safety'};
  const out: {id: string; label: string; value: string; command?: string; tone?: string}[] = enabledItems('status', runtime.config)
    .filter((id) => id !== 'sidebarToggle')
    .map((id) => ({id, label: label[id] ?? id, value: id === 'context' ? `${info.context}%` : String((info as Record<string, unknown>)[id] ?? ''), ...(command[id] ? {command: command[id]} : {})}))
    .filter((s) => s.value);
  // The goal, as the terminal's top bar shows it: ◎ goal · active · 1/3.
  const goal = runtime.goals.goal;
  if (goal) {
    const p = goal.plan ? runtime.goals.plan() : undefined;
    out.push({id: 'goal', label: '◎ goal', value: `${goal.status}${p ? ` · ${progress(p).done}/${progress(p).total}` : ''}`, command: '/goal', tone: goal.status === 'done' ? 'green' : 'cyan'});
  }
  for (const s of out) if (s.id === 'context') s.tone = info.context >= 90 ? 'red' : info.context >= 70 ? 'yellow' : 'green';
  for (const s of out) if (s.id === 'model') s.tone = 'cyan';
  for (const s of out) if (s.id === 'usage') s.tone = 'dim';
  for (const {item, value: seg} of extensions.status) {
    const text = safe(() => seg.render(), '');
    if (text) out.push({id: `${item}:${seg.id}`, label: item, value: text});
  }
  return out;
}

/** /usage rows for the page: account names as the terminal shows them (privacy mode applies). */
export function usageRows(rows: import('../accounts/usage.js').UsageRow[]) {
  return rows.map(({account, snapshot, cooldownUntil, error}) => ({
    provider: PROVIDERS[account.provider].name,
    account: accountLabel(account).startsWith(PROVIDERS[account.provider].name) ? accountLabel(account).slice(PROVIDERS[account.provider].name.length).trim() : accountLabel(account),
    ...(account.plan ? {plan: account.plan} : {}),
    ...(cooldownUntil ? {cooldownUntil} : {}),
    ...(error ? {error} : {}),
    windows: (snapshot?.windows ?? []).map((w) => ({label: windowLabel(w.windowMins), usedPct: Math.round(w.usedPct), ...(w.resetsAt ? {resetsAt: w.resetsAt} : {})})),
  }));
}

/** `progress`: the bar fills toward done (a goal), not toward a limit (an account's usage). */
export type SidebarSection = {id: string; title: string; rows: {text: string; dim?: boolean; bold?: boolean; active?: boolean; pct?: number; progress?: boolean; command?: string}[]};

/** The sidebar: the goal's plan and the task list while there are any, the sections you turned on, then items' sections. */
export function sidebarView(): SidebarSection[] {
  const out: SidebarSection[] = [];
  const g = runtime.goals.goal;
  const plan = g?.plan ? runtime.goals.plan() : undefined;
  if (g && plan) {
    const {done, total, pct} = progress(plan);
    const next = plan.milestones.findIndex((m) => !m.done);
    out.push({
      id: 'plan',
      title: `Goal · ${done}/${total}${g.status === 'active' ? '' : ` · ${g.status}`}`,
      rows: [{text: plan.title, bold: true, command: '/goal'}, {text: '', pct, progress: true}, ...plan.milestones.slice(0, 12).map((m, i) => ({text: `${m.done ? '✓' : i === next ? '▸' : '○'} ${m.text}`, dim: !m.done && i !== next, active: i === next}))],
    });
  }
  const milestones = plan?.milestones.map((m) => m.text) ?? [];
  const todos = (runtime.engine?.transcript.todos ?? []).filter((t) => !milestones.length || !isMilestoneCopy(t, milestones));
  if (todos.some((t) => t.status !== 'completed'))
    out.push({id: 'tasks', title: `Tasks ${todos.filter((t) => t.status === 'completed').length}/${todos.length}`, rows: todos.slice(0, 12).map((t) => ({text: todoLine(t), dim: t.status === 'completed', active: t.status === 'in_progress'}))});
  const title = Object.fromEntries(SIDEBAR_ITEMS.map((i) => [i.id, i.label]));
  for (const id of enabledItems('sidebar', runtime.config)) {
    const rows = safe(() => sectionRows(id), []);
    if (rows) out.push({id, title: title[id] ?? id, rows});
  }
  for (const {item, value: s} of extensions.sidebar) out.push({id: `${item}:${s.id}`, title: s.title, rows: safe(() => s.render(32), ['(this section failed to draw)']).map((text) => ({text}))});
  return out;
}

/** "Claude user@x", but "Claude Account 1" when the label already says which provider (privacy mode). */
const named = (provider: string, label: string) => (label.startsWith(provider) ? label : `${provider} ${label}`);

function sectionRows(id: string): SidebarSection['rows'] | undefined {
  switch (id) {
    case 'agents':
      return [{text: 'main', bold: true, active: true, ...(runtime.engine?.isBusy ? {text: 'main ●'} : {})}, ...runtime.agents.list().filter((a) => runtime.agents.isActive(a)).map((a) => ({text: `${a.name} · ${a.modelLabel ?? a.requested}`, dim: true, command: '/agents'}))];
    case 'accounts': {
      const accounts = [...new Map(catalog.all().flatMap((m) => m.accountIds).map((id) => [id, catalog.account(id)])).values()].filter((a) => !!a);
      if (!accounts.length) return [{text: 'No accounts yet: sign in from a terminal with rein, then /login', dim: true}];
      return accounts.flatMap((a) => [{text: named(PROVIDERS[a!.provider].name, accountLabel(a!)), bold: true, command: '/usage'}, ...(usageStore.get(a!.id)?.windows ?? []).map((w) => ({text: windowLabel(w.windowMins), pct: Math.round(w.usedPct)}))]);
    }
    case 'models': {
      const cfg = runtime.config;
      const selected = cfg.chatModel ?? (defaultRef(cfg) ? refKey(defaultRef(cfg)!) : '');
      return [{value: 'auto', label: 'auto'}, ...catalog.all().map((m) => ({value: refKey(toRef(m)), label: `${m.label} · ${PROVIDERS[m.provider].name}`}))].map((m) => ({text: `${m.value === selected ? '●' : '○'} ${m.label}`, active: m.value === selected, dim: m.value !== selected, command: `/model ${m.value}`}));
    }
    case 'context':
      return [{text: '', pct: contextPct(), command: '/context'}];
    case 'routing': {
      const info = statusInfo();
      return [{text: `decides: ${info.decider}`, dim: true}, {text: runtime.lastDecision ?? `no decisions yet${runtime.config.chatModel === 'auto' ? '' : ' (chat model is fixed)'}`, dim: !runtime.lastDecision}];
    }
    case 'session': {
      const t = runtime.engine?.sessionTokens ?? {uncached: 0, cached: 0, output: 0};
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
      return [
        {text: `${runtime.engine?.transcript.messages.length ?? 0} messages${runtime.engine?.transcript.summary ? ' · summarized' : ''}`, dim: true},
        {text: `uncached ${k(t.uncached)} · cached ${k(t.cached)} · received ${k(t.output)}`, dim: true},
        ...('usd' in t && t.usd !== undefined ? [{text: `cost ≈${formatUsd(t.usd as number)}`, command: '/cost'}] : []),
        {text: '↻ compact', command: '/compact'},
        {text: '☰ settings', command: '/settings'},
      ];
    }
    case 'shortcuts':
      return [{text: 'Enter sends · Shift+Enter newline', dim: true}, {text: '/ commands · @ attach a file', dim: true}, {text: 'Esc stops the agent', dim: true}];
  }
  return undefined;
}

export type SettingsView = {
  tabs: string[];
  tab: string;
  layouts: {title: string; key: 'statusLine' | 'sidebarSections'; items: {id: string; label: string; description: string; on: boolean}[]}[];
  groups: {group: string; settings: {title: string; key: string; description: string; value: unknown; choices: {value: unknown; label: string}[]}[]}[];
  advanced: {key: string; kind: string; description: string; value: string; set: boolean; default: string; choices?: readonly string[]; min?: number; max?: number}[];
};

/** /settings: every tab of the terminal's window, and every config key (Advanced). */
export function settingsView(tab?: string): SettingsView {
  const cfg = runtime.config as Record<string, unknown>;
  const tabs = [...TABS.map((t) => t.title), ...GROUPS, 'Advanced'];
  return {
    tabs,
    tab: tabs.find((t) => t.toLowerCase() === tab?.trim().toLowerCase()) ?? tabs[0]!,
    layouts: TABS.map((t) => {
      const on = enabledItems(t.id === 'status' ? 'status' : 'sidebar', runtime.config);
      // Turned-on items first in their order, then the rest, as the terminal tab lists them.
      const items = [...on.map((id) => t.items.find((i) => i.id === id)!).filter(Boolean), ...t.items.filter((i) => !on.includes(i.id))];
      return {title: t.title, key: t.key, items: items.map((i) => ({id: i.id, label: i.label, description: i.description, on: on.includes(i.id)}))};
    }),
    groups: GROUPS.map((group) => ({group, settings: CHOICE_TABS.filter((d) => d.group === group).map((d) => ({title: d.title, key: d.key, description: d.description, value: cfg[d.key], choices: d.choices}))})),
    advanced: CONFIG_KEYS.map((i) => ({
      key: i.key,
      kind: i.kind,
      description: i.description,
      value: cfg[i.key] === undefined ? '' : formatValue(i, cfg[i.key]),
      set: cfg[i.key] !== undefined,
      default: formatValue(i, defaultValue(i.key)),
      ...(i.kind === 'enum' ? {choices: i.choices} : {}),
      ...(i.kind === 'number' ? {min: i.min, max: i.max} : {}),
    })),
  };
}

/** Change one setting from the web UI: a choice's value as it is, an Advanced key as typed. */
export async function applySetting(key: string, value: unknown, typed: boolean): Promise<void> {
  const info = CONFIG_KEYS.find((i) => i.key === key);
  if (!info) throw new Error(`there's no setting "${key}"`);
  // A choice (General, Agents, Accounts, Safety) must be one the tab offers; anything else is typed and parsed.
  if (!typed) {
    const choice = CHOICE_TABS.find((d) => d.key === key)?.choices.find((c) => JSON.stringify(c.value) === JSON.stringify(value));
    if (!choice) throw new Error(`that isn't one of the choices for ${key}`);
    return runtime.setConfig({[key]: choice.value} as never);
  }
  const v = String(value).trim() === '' ? undefined : parseValue(info, String(value));
  await runtime.setConfig({[key]: v} as never);
}

export type ModelView = {sections: {id: string; title: string; key: string; description: string; value: string; options: {value: string; label: string; hint?: string; disabled?: boolean}[]}[]; effort: {value: string; options: {value: string; label: string; hint?: string}[]}};

/** /model: every section of the terminal's window, with its options and what's chosen. */
export async function modelView(): Promise<ModelView> {
  const hasJev = !!(await getJevKey().catch(() => undefined));
  const cfg = runtime.config;
  const chat = currentValue('chat', cfg);
  return {
    sections: SECTIONS.map((s) => ({id: s.id, title: s.title, key: s.key, description: describe(s.id), value: currentValue(s.id, cfg), options: optionsFor(s.id, hasJev, cfg)})),
    effort: {value: cfg.chatEffort ?? 'auto', options: effortOptions(chat || 'auto')},
  };
}

/** A model section's choice, checked against what it offers. */
export async function applyModel(section: string, value: string): Promise<string> {
  const v = await modelView();
  if (section === 'effort') {
    const o = v.effort.options.find((x) => x.value === value);
    if (!o) throw new Error(`no effort "${value}"`);
    await runtime.setConfig({chatEffort: o.value});
    return `Effort: ${o.label}`;
  }
  const s = v.sections.find((x) => x.id === section);
  const o = s?.options.find((x) => x.value === value);
  if (!s || !o || o.disabled) throw new Error(`can't choose "${value}" there`);
  await runtime.setConfig({[s.key]: o.value} as never);
  return `${s.title}: ${o.label}`;
}

