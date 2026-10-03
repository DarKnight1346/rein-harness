import {readJson, writeJson} from './json.js';
import {paths} from './paths.js';

export type Config = {
  version: 1;
  /** `auto` (decider routes per task) or a model ref like `claude:sonnet`. Unset = resolved at startup. */
  chatModel?: string;
  /** Used when auto routing can't decide confidently. Unset = the provider default. */
  defaultModel?: string;
  /** `jev`, `cheapest` (default without Jev), or a model ref. */
  decisionModel: string;
  /** `cheapest` (default) or a model ref. */
  compactionModel: string;
  /** Advisor the agents can consult (`advisor` tool): `off` (default) or a model ref — never auto. */
  advisorModel: string;
  /** Extra working directories (like Claude Code's additionalDirectories): tools use them without asking. */
  additionalDirectories: string[];
  /** Check npm on launch and install a newer Rein in the background. */
  autoUpdate: boolean;
  /** Show accounts as "Claude Account 1" and redact emails/home paths in the UI (screenshot-safe). */
  hidePersonalInfo: boolean;
  /** New-mode subagents: 'auto' = the agent picks (or the decision model), else a fixed model ref. */
  subagentModel: string;
  /** Model that runs web_search (with its provider's native search) and reads pages for web_fetch. */
  webModel: string;
  /** Auto routing: switch models mid-conversation only when P(switch) ≥ this. */
  autoSwitchThreshold: number;
  /** Auto routing: below this confidence, use the default model. */
  autoMinConfidence: number;
  /** Treat an account as exhausted at this used %. */
  maxUsedPct: number;
  /** Renderer: `fullscreen` (alt screen, mouse, sidebar) or `classic` (inline, native scrollback). */
  tui?: 'fullscreen' | 'classic';
  /** Fullscreen sidebar visibility. */
  sidebar?: boolean;
  /** Status line segments in order (see ui/layout.ts); unset = defaults. */
  statusLine?: string[];
  /** Sidebar sections in order (see ui/layout.ts); unset = defaults. */
  sidebarSections?: string[];
  /**
   * File-changing tools (write/edit/delete): `ask` the user each time; `auto` = the decision model
   * approves changes that clearly match the request and asks the user otherwise; `bypass` = allow all.
   */
  toolApproval: 'ask' | 'auto' | 'bypass';
  /** Longest a foreground shell command may run, in minutes (the agent picks up to this); 0 = no limit. */
  shellMaxMinutes: number;
  /** Automatic goal continuations before the goal pauses itself; 0 = unlimited (default). */
  goalMaxRounds: number;
  /** Max subagents running at once. */
  subagentLimit: number;
  /** Auto-compact when the context reaches this % of the model's window; 0 = off. */
  autoCompactPct: number;
  /** Pinned Jev model id (keeps thresholds calibrated). */
  jevModel: string;
};

export const DEFAULT_CONFIG: Config = {
  version: 1,
  decisionModel: 'cheapest',
  compactionModel: 'cheapest',
  advisorModel: 'off',
  webModel: 'cheapest',
  subagentModel: 'auto',
  hidePersonalInfo: true,
  autoUpdate: true,
  additionalDirectories: [],
  autoSwitchThreshold: 0.7,
  autoMinConfidence: 0.45,
  maxUsedPct: 98,
  autoCompactPct: 80,
  toolApproval: 'ask',
  shellMaxMinutes: 120,
  subagentLimit: 10,
  goalMaxRounds: 0,
  jevModel: 'jev-1.13.0',
};

export async function loadConfig(): Promise<Config> {
  return {...DEFAULT_CONFIG, ...(await readJson<Partial<Config>>(paths.config(), {}))};
}

export async function saveConfig(config: Config): Promise<void> {
  await writeJson(paths.config(), config);
}

export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const next = {...(await loadConfig()), ...patch};
  await saveConfig(next);
  return next;
}
