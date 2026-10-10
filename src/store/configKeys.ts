import {DEFAULT_CONFIG, type Config} from './config.js';

/**
 * Every config key Rein reads, with its type and a one-line description, so each one can be changed
 * from inside Rein (`/settings <key> <value>`, `/settings` → Advanced) as well as in ~/.rein/config.json. A test
 * keeps this in step with `Config`: a key missing here is a hidden setting.
 */
export type KeyKind =
  | {kind: 'string'}
  | {kind: 'number'; min?: number; max?: number}
  | {kind: 'boolean'}
  | {kind: 'enum'; choices: readonly string[]}
  /** A list of strings, written comma-separated. */
  | {kind: 'list'}
  /** An object or array, written as JSON. */
  | {kind: 'json'};

export type KeyInfo = KeyKind & {key: keyof Config; description: string};

const k = <T extends KeyKind>(key: keyof Config, description: string, kind: T): KeyInfo => ({key, description, ...kind});
const str = {kind: 'string'} as const;
const bool = {kind: 'boolean'} as const;
const list = {kind: 'list'} as const;
const json = {kind: 'json'} as const;
const num = (min?: number, max?: number) => ({kind: 'number' as const, min, max});
const oneOf = (...choices: string[]) => ({kind: 'enum' as const, choices});

export const CONFIG_KEYS: KeyInfo[] = [
  k('chatModel', 'Model for chat: a model id such as claude:opus, or auto', str),
  k('defaultModel', "Fallback model when auto routing isn't confident or nothing is pinned (provider:model)", str),
  k('decisionModel', 'Model that routes auto mode and judges approvals: jev, cheapest or provider:model', str),
  k('compactionModel', 'Model that writes compaction summaries: cheapest or provider:model', str),
  k('advisorModel', 'Stronger model agents can consult (provider:model), or off', str),
  k('subagentModel', 'Your model for new subagents: auto (no choice) or provider:model', str),
  k('subagentPriority', "Whose choice wins for a subagent's model: yours (user) or the agent's", oneOf('user', 'agent')),
  k('webModel', 'Model that runs web_search and answers web_fetch prompts: cheapest or provider:model', str),
  k('chatEffort', 'Reasoning effort for chat: auto, default or a level the model supports', str),
  k('jevModel', 'Pinned Jev model id (keeps the decision thresholds calibrated)', str),
  k('loadBalancing', 'Spread work across accounts (balanced) or stay on one until its limit (sticky)', oneOf('balanced', 'sticky')),
  k('autoSwitchThreshold', 'Auto routing switches models mid-conversation only when the decider is at least this sure (0–1) the task changed', num(0, 1)),
  k('autoMinConfidence', 'Lowest decision-model confidence (0–1) auto routing acts on', num(0, 1)),
  k('maxUsedPct', 'Used % at which an account counts as exhausted', num(0, 100)),
  k('apiAccounts', 'Use API-key accounts only as a fallback, or always alongside subscriptions', oneOf('fallback', 'always')),
  k('waitForLimits', 'When every account is at its limit, wait for the reset and continue (true) or stop', bool),
  k('additionalDirectories', 'Extra working directories the agent may use without asking', list),
  k('toolApproval', 'Approval mode for file changes: ask, auto or bypass', oneOf('ask', 'auto', 'bypass')),
  k('sandbox', 'Command sandbox: write (default), strict (no network), container (a Docker/Podman container per conversation) or off', oneOf('write', 'strict', 'container', 'off')),
  k('containerSandbox', 'For sandbox container: {"image": "node:22-bookworm", "runtime": "docker" | "podman", "egress": ["registry.npmjs.org", "*.github.com"]} (no network unless hosts are listed)', json),
  k('shellMaxMinutes', 'Longest a foreground shell command may run, in minutes (0 = no limit)', num(0)),
  k('secretScan', 'A write or edit that adds something like a credential: warn the agent, block the change, or off. On, credentials are also masked in saved conversations', oneOf('off', 'warn', 'block')),
  k('sast', 'Run Semgrep on what each request changed, at the end of the turn (findings on added lines go back to the agent): semgrep or off', oneOf('off', 'semgrep')),
  k('sastConfig', 'Semgrep rules: auto, a registry pack like p/owasp-top-ten, or a path to your rules', str),
  k('injectionScan', "Flag instructions planted in web pages, search results and MCP results, and tell the agent they're data", bool),
  k('exfilGuard', 'Once outside content and private data have both been in a conversation, network calls (web_fetch, MCP, curl, git push…) need your yes', bool),
  k('depCheck', 'Vet packages a change adds (does it exist, typosquat, license, known vulnerabilities): warn, block or off. Looks them up on the registries and OSV', oneOf('off', 'warn', 'block')),
  k('buildTimeWarnings', 'Tell you when a build or test command takes much longer than its recent runs (1.5× and 30 s more)', bool),
  k('steerShell', 'Run simple shell reads and searches (cat, grep -rn, sed -n…) as the built-in tools', bool),
  k('goalMaxRounds', 'Most automatic continuations per goal (0 = no limit)', num(0)),
  k('subagentLimit', 'Most subagents running at once', num(1)),
  k('worktrees', 'Give parallel subagents their own git worktree (auto) or not (off)', oneOf('auto', 'off')),
  k('contextWarnings', "Say when the context passes 50%, 70% and 85% full, and what's taking the space", bool),
  k('autoCompactPct', 'Compact when the context is this % full (0 = off)', num(0, 100)),
  k('experiments', 'Efficiency experiments to turn on, or -name to turn a default one off', list),
  k('packs', 'Command packs to turn on (specialist commands and skills, all off by default): ci, specs, migrations, system, codebase, insight', list),
  k('prices', 'USD per million tokens for models without a built-in price: {"codex:my-model": {"input": 1.5, "cached": 0.15, "output": 6}}', json),
  k('budget', 'Spending caps in USD at API prices: {"requestUsd": 2, "goalUsd": 20, "conversationUsd": 50}', json),
  k('goalConfirmUsd', '/goal asks before starting when goals here typically cost more than this many USD (0 = never asks)', num(0)),
  k('otel', 'OpenTelemetry export: {"endpoint": "http://localhost:4318", "headers": {}, "serviceName": "rein"}', json),
  k('codeSearch', 'Org-wide code search for the agent (org_search): {"type": "sourcegraph", "url": "https://sourcegraph.example.com"} or type zoekt. Sourcegraph token: SRC_ACCESS_TOKEN', json),
  k('semanticIndex', 'Local semantic search through Ollama: {} for nomic-embed-text at 127.0.0.1:11434, or {"model": "…", "url": "…"}. Build the index with /index', json),
  k('lsp', 'Code intelligence through language servers: auto or off', oneOf('auto', 'off')),
  k('lspIdleMinutes', 'Stop a language server after this many idle minutes', num(1)),
  k('lspServers', 'Your own language servers: {"ruby": {"command": "solargraph", "args": ["stdio"]}}', json),
  k('mcpPinning', "Pin each MCP server's launch config and tools when first used; if either changes, its tools are held until you review it in /mcp", bool),
  k('mcpSampling', 'When an MCP server asks for a completion: ask, allow or off', oneOf('ask', 'allow', 'off')),
  k('tui', 'Renderer: fullscreen or classic', oneOf('fullscreen', 'classic')),
  k('sidebar', 'Show the sidebar in fullscreen mode', bool),
  k('statusLine', 'Status line segments, in order', list),
  k('sidebarSections', 'Sidebar sections, in order', list),
  k('inlineImages', 'Show images inline where the terminal supports it: auto or off', oneOf('auto', 'off')),
  k('rtl', 'Right-to-left text display: auto, on or off', oneOf('auto', 'on', 'off')),
  k('collapsePastes', 'Show long pastes as a placeholder instead of the full text', bool),
  k('hidePersonalInfo', 'Privacy mode: hide emails and paths on screen', bool),
  k('theme', 'The look of the UI: {"accent": "magenta"} (a colour name or #hex) for the input box, window frames and selections', json),
  k('pet', 'Your pet from the ChatGPT and Codex apps, in the sidebar (needs a Codex account): auto or off', oneOf('auto', 'off')),
  k('notifications', 'When Rein needs you: terminal, system (desktop too) or off', oneOf('terminal', 'system', 'off')),
  k('notifyUrl', 'URL Rein POSTs notifications to (ntfy, Slack or Discord webhook, or JSON); empty for none', str),
  k('autoUpdate', 'Install new Rein versions in the background', bool),
  k('attribution', 'Credit Rein in commits and pull requests', bool),
  k('provenance', 'Commits and PRs the agent makes end with Rein-Session, Rein-Model and Rein-Goal trailers', bool),
  k('devEnvironment', "Run the agent's commands in the repo's dev container (devcontainer exec) or Nix/devbox shell: off, auto (whichever the repo has), devcontainer, nix or devbox", oneOf('off', 'auto', 'devcontainer', 'nix', 'devbox')),
  k('planReview', "A second model critiques each plan (and a spec's design) before you see it: other (the other provider's best model), advisor (advisorModel) or off", oneOf('off', 'other', 'advisor')),
  k('prMaxLines', 'Tell you when the branch changes more lines than this (0 = off); /pr split then offers to split it', num(0)),
  k('remoteHost', 'Address /remote listens on', str),
  k('remotePort', 'Port /remote listens on', num(1, 65535)),
  k('trackers', 'Issue trackers Rein takes labelled issues from (see /trackers)', json),
  k('trackerPollMinutes', 'How often to look for new issues, in minutes', num(1)),
  k('voiceModel', 'whisper.cpp model for voice input', str),
  k('backgroundCheckMinutes', 'Every this many minutes, check whether a background command is still needed (0 = off)', num(0)),
];

export const keyInfo = (key: string) => CONFIG_KEYS.find((x) => x.key === key);

/** Current value as text, the way /settings shows and edits it. */
export function formatValue(info: KeyInfo, v: unknown): string {
  if (v === undefined) return '(not set)';
  if (info.kind === 'list') return Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : String(v);
  if (info.kind === 'json') return JSON.stringify(v);
  return String(v);
}

/** Parse what you typed for a key. Throws a message saying what's expected. */
export function parseValue(info: KeyInfo, text: string): unknown {
  const t = text.trim();
  switch (info.kind) {
    case 'string':
      return t.replace(/^"(.*)"$/, '$1');
    case 'boolean':
      if (/^(true|on|yes)$/i.test(t)) return true;
      if (/^(false|off|no)$/i.test(t)) return false;
      throw new Error(`${info.key} is true or false`);
    case 'number': {
      const n = Number(t);
      if (!t || !Number.isFinite(n)) throw new Error(`${info.key} is a number`);
      if ((info.min !== undefined && n < info.min) || (info.max !== undefined && n > info.max)) throw new Error(`${info.key} is between ${info.min ?? '−∞'} and ${info.max ?? '∞'}`);
      return n;
    }
    case 'enum':
      if (!info.choices.includes(t)) throw new Error(`${info.key} is one of: ${info.choices.join(', ')}`);
      return t;
    case 'list':
      return t === '' || t === '(none)' ? [] : t.split(',').map((s) => s.trim()).filter(Boolean);
    case 'json':
      try {
        const v = JSON.parse(t);
        if (v === null || typeof v !== 'object') throw new Error();
        return v;
      } catch {
        throw new Error(`${info.key} is JSON, e.g. ${info.description.match(/\{.*\}/)?.[0] ?? '{}'}`);
      }
  }
}

/** The value `reset` restores: the default, or nothing for keys without one. */
export const defaultValue = (key: keyof Config): unknown => (DEFAULT_CONFIG as Partial<Config>)[key];
