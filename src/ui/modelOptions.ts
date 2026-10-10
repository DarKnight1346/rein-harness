import {PROVIDERS, parseRef, refKey} from '../providers/types.js';
import {catalog, toRef, type CatalogModel} from '../router/catalog.js';
import {defaultRef} from '../router/index.js';
import type {Config} from '../store/config.js';
import {modelLabel} from './format.js';

/** What /model offers, per section: shared by the terminal window (ModelScreen) and the web UI. */
export type Section = 'chat' | 'subagent' | 'priority' | 'decision' | 'compaction' | 'advisor' | 'web';
export const SECTIONS: {id: Section; title: string; key: keyof Config}[] = [
  {id: 'chat', title: 'Chat model', key: 'chatModel'},
  {id: 'subagent', title: 'Subagents', key: 'subagentModel'},
  {id: 'priority', title: 'Subagent priority', key: 'subagentPriority'},
  {id: 'decision', title: 'Decision model', key: 'decisionModel'},
  {id: 'compaction', title: 'Compaction model', key: 'compactionModel'},
  {id: 'advisor', title: 'Advisor', key: 'advisorModel'},
  {id: 'web', title: 'Web', key: 'webModel'},
];

export type Option = {value: string; label: string; hint?: string; disabled?: boolean};


export const EFFORT_HINTS: Record<string, string> = {
  low: 'fastest, cheapest',
  medium: 'balanced',
  high: 'harder problems',
  xhigh: 'very hard problems',
  max: 'may use excessive tokens — hardest tasks only',
  ultra: 'maximum reasoning (Codex)',
};

/** Effort choices for a chat model value (a ref, or 'auto' → the union of common levels). */
export function effortOptions(value: string): Option[] {
  const ref = value === 'auto' ? undefined : parseRef(value);
  const m = ref ? catalog.get(ref) : undefined;
  const levels = m?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  return [
    {value: 'auto', label: 'Auto', hint: 'the decision model picks per task (when the cache is cold)'},
    {value: 'default', label: 'Model default', hint: m?.defaultEffort ? `currently ${m.defaultEffort}` : 'whatever the model uses by default'},
    ...levels.map((l) => ({value: l, label: l, hint: EFFORT_HINTS[l]})),
  ];
}

export function describe(s: Section): string {
  if (s === 'chat') return 'Model that answers you. auto = the decision model routes each task.';
  if (s === 'decision') return 'Routes auto mode and picks failover models. Jev if you have a key; else a cheap model with strict prompts.';
  if (s === 'subagent') return 'Your model for new subagents (auto = none). Whether it overrides the agent\'s own pick is set in Subagent priority. Forked subagents keep the current model.';
  if (s === 'priority') return 'Order used to choose a new subagent\'s model. Forked subagents always keep the current agent\'s model.';
  if (s === 'web') return 'Runs web_search with its provider\'s built-in search, and reads fetched pages for web_fetch. Any signed-in Claude or Codex model works.';
  if (s === 'advisor') return 'A stronger (pricier) model agents can consult via the advisor tool for guidance at key moments. Off by default; never auto.';
  return 'Summarizes the conversation for /compact, long chats and handoffs between models.';
}

function modelOptions(models: CatalogModel[]): Option[] {
  return models.map((m) => ({
    value: refKey(toRef(m)),
    label: `${m.label}`,
    hint: `${PROVIDERS[m.provider].name}${m.description ? ` · ${truncate(m.description, 60)}` : ''}`,
  }));
}

export function optionsFor(s: Section, hasJev: boolean, cfg: Config): Option[] {
  const models = catalog.all();
  const cheapest = catalog.cheapest(cfg.maxUsedPct);
  const cheapestHint = cheapest ? `currently ${cheapest.label}` : 'no model available';
  if (s === 'chat') {
    const decider = cfg.decisionModel === 'jev' && hasJev ? 'Jev' : 'the decision model';
    return [{value: 'auto', label: 'auto', hint: `${decider} picks per task`}, ...modelOptions(models)];
  }
  if (s === 'subagent') {
    return [{value: 'auto', label: 'auto', hint: 'no model of your own: the agent picks, or the decision model'}, ...modelOptions(models)];
  }
  if (s === 'priority') {
    return [
      {value: 'user', label: 'Your model first', hint: 'your Subagents model → the agent\'s choice → auto (default)'},
      {value: 'agent', label: 'Agent\'s choice first', hint: 'the agent\'s choice → your Subagents model → auto'},
    ];
  }
  if (s === 'decision') {
    return [
      {value: 'jev', label: 'Jev', hint: hasJev ? 'typesafe.ai · fast, ~free' : 'add a Jev API key in /login first', disabled: !hasJev},
      {value: 'cheapest', label: 'Cheapest available', hint: cheapestHint},
      ...modelOptions(models),
    ];
  }
  if (s === 'advisor') {
    // Most capable first: that's what an advisor is for.
    return [{value: 'off', label: 'Off', hint: 'agents get no advisor tool'}, ...modelOptions([...models].sort((a, b) => b.tier - a.tier))];
  }
  return [{value: 'cheapest', label: 'Cheapest available', hint: cheapestHint}, ...modelOptions(models)];
}

export function currentValue(s: Section, cfg: Config): string {
  if (s === 'chat') {
    if (cfg.chatModel) return cfg.chatModel;
    const d = defaultRef(cfg);
    return d ? refKey(d) : '';
  }
  if (s === 'subagent') return cfg.subagentModel ?? 'auto';
  if (s === 'priority') return cfg.subagentPriority ?? 'user';
  return s === 'decision' ? cfg.decisionModel : s === 'advisor' ? cfg.advisorModel : s === 'web' ? cfg.webModel : cfg.compactionModel;
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** `/model <query>`: `auto`, a ref (`codex:gpt-6-luna`), an id or a label. */
export function resolveModelQuery(query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  if (q === 'auto') return 'auto';
  const ref = parseRef(q);
  if (ref && catalog.get(ref)) return refKey(ref);
  const m = catalog.all().find((x) => x.id.toLowerCase() === q || x.label.toLowerCase() === q);
  return m ? refKey(toRef(m)) : undefined;
}

export const describeChatModel = (value: string) => (value === 'auto' ? 'auto' : modelLabel(parseRef(value) ?? {provider: 'claude', model: value}));
