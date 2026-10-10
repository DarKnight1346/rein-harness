import {readJson, writeJson} from './json.js';
import {paths} from './paths.js';
import type {Price} from '../providers/prices.js';
import type {OtelConfig} from '../telemetry/otel.js';
import type {Budget} from '../budget.js';
import type {CodeSearchConfig} from '../context/orgSearch.js';
import type {SemanticConfig} from '../context/semantic.js';

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
  /** Account choice: 'balanced' spreads use across subscriptions at cache-cold moments; 'sticky' stays until limited. */
  loadBalancing: 'balanced' | 'sticky';
  /** Extra working directories (like Claude Code's additionalDirectories): tools use them without asking. */
  additionalDirectories: string[];
  /** Check npm on launch and install a newer Rein in the background. */
  autoUpdate: boolean;
  /** Show accounts as "Claude Account 1" and redact emails/home paths in the UI (screenshot-safe). */
  hidePersonalInfo: boolean;
  /**
   * Effort for the chat model: 'auto' = the decision model picks (only when the prompt cache is
   * cold — changing effort invalidates it), 'default' = the model's own default, or a level.
   */
  chatEffort: string;
  /** The user's subagent model ('auto' = none chosen) for new-mode subagents. */
  subagentModel: string;
  /**
   * Who wins for new-mode subagents: 'user' = your model → the agent's choice → auto;
   * 'agent' = the agent's choice → your model → auto. Forks always keep the current model.
   */
  subagentPriority: 'user' | 'agent';
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
  /** Get your attention when Rein needs you or finished a long task: terminal bell + OSC 9, also a desktop notification, or off. */
  notifications: 'terminal' | 'system' | 'off';
  /** Subagents working alongside other work get their own git worktree, merged back when they finish ('auto'), or always share the project ('off'). */
  worktrees: 'auto' | 'off';
  /** API accounts (pay per use): 'fallback' = only when no subscription can serve the model (default), 'always' = alongside subscriptions (after them). */
  apiAccounts: 'fallback' | 'always';
  /** Built-in code intelligence: Rein runs language servers itself ('auto', the default), or never ('off'). */
  lsp: 'auto' | 'off';
  /** Stop a built-in language server after this many minutes unused (default 10). */
  lspIdleMinutes: number;
  /** Use a specific language server command instead of Rein's: {"typescript": {"command": "/path/to/server", "args": ["--stdio"]}}. */
  lspServers?: Record<string, {command: string; args?: string[]}>;
  /** Every account at its limit: wait for the reset (up to 12 hours) and continue, instead of stopping. */
  waitForLimits: boolean;
  /** USD per million tokens for models Rein has no price for, or to override one: {"codex:my-model": {input, output, cached}}. */
  prices?: Record<string, Price>;
  /** Spending caps in USD at API list prices: {requestUsd, goalUsd, conversationUsd}. A repo's .rein/settings.json can set lower ones. */
  budget?: Budget;
  /** /goal asks before starting when goals here typically cost more than this (USD, API prices). 0 = never asks. */
  goalConfirmUsd: number;
  /** Say when the context passes 50%, 70% and 85% full, and what's taking the space. */
  contextWarnings: boolean;
  /** A write or edit that adds something like a credential: tell the agent (warn), refuse it (block), or nothing (off). */
  secretScan: 'off' | 'warn' | 'block';
  /** Static analysis of each request's changes at the end of the turn: semgrep (when installed) or off. */
  sast: 'off' | 'semgrep';
  /** Flag instructions planted in web pages, search results and MCP results (the agent is told they're data). */
  injectionScan: boolean;
  /** Once outside content and private data have both been in a conversation, network calls need your yes. */
  exfilGuard: boolean;
  /** Pin each MCP server's config and tools when first approved; a changed server's tools wait for your review. */
  mcpPinning: boolean;
  /** Vet packages a change adds (exists, typosquat, license, known vulnerabilities via OSV): warn, block or off. */
  depCheck: 'off' | 'warn' | 'block';
  /** Tell you when a build or test command takes much longer than its recent runs. */
  buildTimeWarnings: boolean;
  /** Commits and PRs the agent makes end with Rein-Session / Rein-Model / Rein-Goal trailers. */
  provenance: boolean;
  /** Tell you when the branch changes more lines than this (reviews slow down past a few hundred). 0 = off. */
  prMaxLines: number;
  /** Org-wide code search: {"type": "sourcegraph" | "zoekt", "url": "…"}; the agent gets org_search. */
  codeSearch?: CodeSearchConfig;
  /** Local semantic index through Ollama: {} for the defaults, or {"model", "url"}. /index builds it; the agent gets semantic_search. */
  semanticIndex?: SemanticConfig;
  /** Semgrep rules (--config): auto, a registry pack like p/owasp-top-ten, or a path. */
  sastConfig: string;
  /** OpenTelemetry export of turns, tool calls, tokens and cost (metadata only). Off unless set. */
  otel?: OtelConfig;
  /** Efficiency experiments to turn on, by name (see the configuration reference): measured before they become defaults. */
  experiments: string[];
  /** Run simple shell reads and searches the agent writes (cat, head, grep -rn, sed -n, ls, find -name) as the built-in tools. */
  steerShell: boolean;
  /** MCP servers asking for a completion (sampling): ask you per server (default), allow, or refuse. */
  mcpSampling: 'ask' | 'allow' | 'off';
  /** Show images the agent makes or reads in the terminal, where it can draw them (iTerm2, WezTerm, kitty, Ghostty). */
  inlineImages: 'auto' | 'off';
  /** Right-to-left text (Hebrew, Arabic): reorder it for display where the terminal doesn't ('auto'), always, or never. */
  rtl: 'auto' | 'on' | 'off';
  /** The remote page's address (/remote): this computer only by default; reach it through a tunnel. */
  remoteHost: string;
  remotePort: number;
  /** Issue trackers that hand work to Rein (trackers/): an issue assigned to you with the label starts a session on its own branch. */
  trackers: import('../trackers/types.js').TrackerConfig[];
  /** How often to look for new issues, in minutes (default 2). */
  trackerPollMinutes: number;
  /** A URL Rein POSTs to when it needs you or finished something (ntfy, Slack, Discord, or any JSON webhook). */
  notifyUrl: string;
  /** Commits and pull requests the agent writes credit Rein (a "Co-Authored by [Rein Harness](…)" line). */
  attribution: boolean;
  /** whisper.cpp model for voice input (hold Ctrl+Space): `base.en-q5_1` (English, default), or e.g. `base-q5_1` / `small-q5_1` for other languages. */
  voiceModel: string;
  /** Big pastes (more than 3 lines or 800 characters) become a `[Pasted text #1 +40 lines]` placeholder in the input; false pastes the text as-is. */
  collapsePastes: boolean;
  /** OS sandbox for the agent's shell commands: 'write' (default: writes limited to the project), 'strict' (also no network), 'off'. */
  sandbox: 'write' | 'strict' | 'off';
  /** Every this many minutes of a background command's life, a fork of the agent checks it's still needed and stops it if not; 0 = off. */
  backgroundCheckMinutes: number;
};

export const DEFAULT_CONFIG: Config = {
  version: 1,
  decisionModel: 'cheapest',
  compactionModel: 'cheapest',
  advisorModel: 'off',
  webModel: 'cheapest',
  subagentModel: 'auto',
  chatEffort: 'auto',
  subagentPriority: 'user',
  hidePersonalInfo: true,
  autoUpdate: true,
  additionalDirectories: [],
  loadBalancing: 'balanced',
  autoSwitchThreshold: 0.7,
  autoMinConfidence: 0.45,
  maxUsedPct: 98,
  autoCompactPct: 80,
  toolApproval: 'ask',
  shellMaxMinutes: 120,
  subagentLimit: 10,
  goalMaxRounds: 0,
  jevModel: 'jev-1.13.0',
  notifications: 'terminal',
  backgroundCheckMinutes: 60,
  sandbox: 'write',
  apiAccounts: 'fallback',
  collapsePastes: true,
  attribution: true,
  waitForLimits: true,
  goalConfirmUsd: 0,
  contextWarnings: true,
  secretScan: 'off',
  sast: 'off',
  injectionScan: false,
  exfilGuard: false,
  mcpPinning: false,
  depCheck: 'off',
  buildTimeWarnings: true,
  provenance: false,
  prMaxLines: 0,
  sastConfig: 'auto',
  steerShell: true,
  mcpSampling: 'ask',
  inlineImages: 'auto',
  rtl: 'auto',
  remoteHost: '127.0.0.1',
  remotePort: 7377,
  trackers: [],
  trackerPollMinutes: 2,
  notifyUrl: '',
  voiceModel: 'base.en-q5_1',
  lsp: 'auto',
  lspIdleMinutes: 10,
  worktrees: 'auto',
  experiments: [],
};

/**
 * Experiments that measured better than plain Claude Code (cost, time and tasks solved, epic benchmark)
 * and are now on unless turned off with `-name` in `experiments`. These change no feature you see.
 */
export const DEFAULT_EXPERIMENTS = ['lean-subagents', 'compact-read', 'outline-reads', 'shell-cap', 'faithful-compaction'];
/**
 * Also on in `rein -p`, where they were measured: a one-off run has no idle pauses (5-minute cache), no
 * one reading a task list, MCP tools or a long final reply, no one to mind a capped context, and a
 * task long enough that an extra turn checking every requirement is cheap next to it.
 */
export const HEADLESS_EXPERIMENTS = ['lazy-tools', 'no-todo', 'brief-final', 'context-cap', 'cache-5m', 'verify-requirements'];
/** Defaults for this process only (`rein -p` adds HEADLESS_EXPERIMENTS). */
const processDefaults: string[] = [];
export function addDefaultExperiments(names: string[]): void {
  processDefaults.push(...names);
}

/** The experiments that are on: the defaults plus `experiments`, minus any listed as `-name`. */
export function activeExperiments(cfg: Pick<Config, 'experiments'>): string[] {
  const listed = cfg.experiments ?? [];
  const off = new Set(listed.filter((e) => e.startsWith('-')).map((e) => e.slice(1)));
  return [...new Set([...DEFAULT_EXPERIMENTS, ...processDefaults, ...listed])].filter((e) => !e.startsWith('-') && !off.has(e));
}

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
