import type {Config} from '../store/config.js';
import {DEFAULT_SIDEBAR, DEFAULT_STATUS, SIDEBAR_ITEMS, STATUS_ITEMS, type LayoutItem} from './layout.js';

/** The /settings tabs and their choices: shared by the terminal window (ConfigureScreen) and the web UI. */
export type Tab = {id: 'status' | 'sidebar'; title: string; items: LayoutItem[]; defaults: string[]; key: 'statusLine' | 'sidebarSections'};
export const TABS: Tab[] = [
  {id: 'status', title: 'Status line', items: STATUS_ITEMS, defaults: DEFAULT_STATUS, key: 'statusLine'},
  {id: 'sidebar', title: 'Sidebar', items: SIDEBAR_ITEMS, defaults: DEFAULT_SIDEBAR, key: 'sidebarSections'},
];
export type Choice = {value: string | number | boolean; label: string};
export type Group = 'General' | 'Agents' | 'Accounts' | 'Safety';
export type ChoiceTabDef = {title: string; group: Group; key: keyof Config; description: string; choices: Choice[]};
export const CHOICE_TABS: ChoiceTabDef[] = [
  {
    title: 'Approvals',
    group: 'General',
    key: 'toolApproval',
    description: 'What happens when the agent wants to write, edit or delete a file. Reads and searches never ask.',
    choices: [
      {value: 'ask', label: 'Ask — confirm every file change  (default)'},
      {value: 'auto', label: 'Auto — the decision model approves changes that clearly match your request; asks you otherwise'},
      {value: 'bypass', label: 'Bypass — allow every file change without asking'},
    ],
  },
  {
    title: 'Sandbox',
    group: 'General',
    key: 'sandbox',
    description: "An OS sandbox around the agent's shell commands (macOS sandbox-exec, Linux bubblewrap). Your own ! commands, hooks and MCP servers aren't sandboxed.",
    choices: [
      {value: 'write', label: 'On — commands can only write inside the project, scratchpad, temp folders and package caches  (default)'},
      {value: 'strict', label: 'Strict — the same, and no network except localhost'},
      {value: 'container', label: 'Container — a Docker or Podman container per conversation, network only to the hosts in containerSandbox'},
      {value: 'off', label: 'Off — no sandbox; approvals are the only guard'},
    ],
  },
  {
    title: 'Dev environment',
    group: 'General',
    key: 'devEnvironment',
    description: "Run the agent's commands in the repo's own environment: its dev container (devcontainer exec) or its Nix / devbox shell. Commands run on this machine when the tool isn't installed.",
    choices: [
      {value: 'off', label: 'Off — commands run on this machine  (default)'},
      {value: 'auto', label: 'Auto — whichever the repo has (.devcontainer, flake.nix, shell.nix, devbox.json)'},
      {value: 'devcontainer', label: 'Dev container only'},
      {value: 'nix', label: 'Nix shell only'},
      {value: 'devbox', label: 'devbox only'},
    ],
  },
  {
    title: 'Shell',
    group: 'General',
    key: 'shellMaxMinutes',
    description: 'Longest a foreground command may run. The agent picks a timeout per command (2 min by default) up to this cap. Background processes have no limit.',
    choices: [10, 30, 60, 120, 240, 480, 0].map((v) => ({
      value: v,
      label: v === 0 ? 'No limit' : `${v < 60 ? `${v} minutes` : `${v / 60} hour${v === 60 ? '' : 's'}`}${v === 120 ? '  (default)' : ''}`,
    })),
  },
  {
    title: 'Subagents',
    group: 'Agents',
    key: 'subagentLimit',
    description: 'How many subagents may run at once (the agent is told the limit and waits or does the work itself when it is reached).',
    choices: [1, 2, 3, 5, 10, 20].map((v) => ({value: v, label: `${v} at a time${v === 10 ? '  (default)' : ''}`})),
  },
  {
    title: 'Goals',
    group: 'Agents',
    key: 'goalMaxRounds',
    description: 'How many automatic continuations a /goal may take before it pauses itself (/goal resume continues).',
    choices: [0, 10, 25, 50, 100, 250].map((v) => ({value: v, label: v === 0 ? 'Unlimited  (default)' : `${v} continuations`})),
  },
  {
    title: 'Load balancing',
    group: 'Accounts',
    key: 'loadBalancing',
    description: 'How Rein spreads work across your subscriptions. Balanced moves a conversation to the account with the most room only when its prompt cache has gone cold (idle 5+ min) or the account is near its limit; new chats and subagents start on the least-used account.',
    choices: [
      {value: 'balanced', label: 'Balanced  (default) — cache-aware'},
      {value: 'sticky', label: 'Sticky — stay on one account until it hits a limit'},
    ],
  },
  {
    title: 'Notifications',
    group: 'General',
    key: 'notifications',
    description: 'Get your attention when Rein needs you (an approval, a question, a plan to review) or finishes a task that took a while.',
    choices: [
      {value: 'terminal', label: 'Terminal — bell + terminal notification (iTerm2, WezTerm, kitty, Ghostty…)  (default)'},
      {value: 'system', label: 'Desktop — also a macOS / Linux desktop notification'},
      {value: 'off', label: 'Off'},
    ],
  },
  {
    title: 'Paste',
    group: 'General',
    key: 'collapsePastes',
    description: 'Big pastes (more than 3 lines or 800 characters) can show in the input as a short placeholder, sent in full with your message, or go in as plain text you can edit.',
    choices: [
      {value: true, label: 'Placeholder — [Pasted text #1 +40 lines]  (default)'},
      {value: false, label: 'Plain text — paste it into the input as-is'},
    ],
  },
  {
    title: 'Limits',
    group: 'Accounts',
    key: 'waitForLimits',
    description: 'When every account for the model is at its usage limit (and no other model can take over), Rein can wait for the earliest reset and carry on by itself: a goal left running overnight keeps going. Waits of more than 12 hours (a weekly limit) are not waited for. Esc stops a wait.',
    choices: [
      {value: true, label: 'Wait for the reset and continue  (default)'},
      {value: false, label: 'Stop and tell me'},
    ],
  },
  {
    title: 'Attribution',
    group: 'General',
    key: 'attribution',
    description: 'Commits and pull requests the agent writes end with a line crediting Rein: "Co-Authored by [Rein Harness](https://github.com/DarKnight1346/rein-harness)". Takes effect on the next turn.',
    choices: [
      {value: true, label: 'On — credit Rein in commits and PRs  (default)'},
      {value: false, label: 'Off — no attribution line'},
    ],
  },
  {
    title: 'Worktrees',
    group: 'Agents',
    key: 'worktrees',
    description: "Subagents working at the same time as other work get their own copy of the project (a git worktree), so they can't trip over each other. Their changes merge back on their own when they finish; you never manage a worktree.",
    choices: [
      {value: 'auto', label: 'Automatic — only when subagents work in parallel  (default)'},
      {value: 'off', label: 'Off — subagents always edit the project directly'},
    ],
  },
  {
    title: 'API accounts',
    group: 'Accounts',
    key: 'apiAccounts',
    description: 'When Rein uses pay-per-use API accounts (Anthropic Console, Bedrock, Vertex, OpenAI keys) added in /login. Subscriptions always come first.',
    choices: [
      {value: 'fallback', label: 'Fallback — only when no subscription can serve the model  (default)'},
      {value: 'always', label: 'Always — alongside subscriptions (after them)'},
    ],
  },
  {
    title: 'Updates',
    group: 'General',
    key: 'autoUpdate',
    description: 'On launch, check npm for a newer Rein and install it in the background (takes effect next start). /update or rein --update also updates the claude and codex CLIs.',
    choices: [
      {value: true, label: 'Auto-update Rein  (default)'},
      {value: false, label: 'Only when I run /update'},
    ],
  },
  {
    title: 'Privacy',
    group: 'General',
    key: 'hidePersonalInfo',
    description: 'Hide your emails and username in the UI so screenshots are safe to share. Accounts show as "Claude Account 1", "Codex Account 1"; your home folder shows as ~.',
    choices: [
      {value: true, label: 'Hide personal info  (default)'},
      {value: false, label: 'Show emails and paths'},
    ],
  },
  {
    title: 'Pet',
    group: 'General',
    key: 'pet',
    description: 'Your animated companion from the ChatGPT and Codex apps, at the bottom of the sidebar, reacting to what the agent does. It comes from your ChatGPT account, so it needs a Codex account; /pet picks one.',
    choices: [
      {value: 'auto', label: 'Show my pet  (default)'},
      {value: 'off', label: 'Off'},
    ],
  },
  {
    title: 'Compaction',
    group: 'Agents',
    key: 'autoCompactPct',
    description: "Summarize the conversation automatically when the context reaches this share of the model's window — mid-turn too: the agent keeps working from the summary.",
    choices: [0, 50, 60, 70, 80, 90, 95].map((v) => ({
      value: v,
      label: v === 0 ? 'Off (only /compact, or when a model rejects a full context)' : `At ${v}% of the context window${v === 80 ? '  (default)' : ''}`,
    })),
  },
  {
    title: 'Plan review',
    group: 'Agents',
    key: 'planReview',
    description: "A second model critiques each plan (and a spec's design) before you see it; the agent folds in what holds up, then presents it to you.",
    choices: [
      {value: 'off', label: 'Off  (default)'},
      {value: 'other', label: "Other provider — the other provider's best model (Codex reviews Claude's plan, and the other way round)"},
      {value: 'advisor', label: 'Advisor — the advisor model (advisorModel)'},
    ],
  },
  {
    title: 'Secrets',
    group: 'Safety',
    key: 'secretScan',
    description: 'When a write or edit adds something that looks like a credential (API keys, tokens, private keys). On, credentials are also masked in saved conversations.',
    choices: [
      {value: 'off', label: 'Off  (default)'},
      {value: 'warn', label: 'Warn — the change goes through and the agent is told'},
      {value: 'block', label: 'Block — the change is refused with the reason'},
    ],
  },
  {
    title: 'Semgrep',
    group: 'Safety',
    key: 'sast',
    description: 'Run Semgrep (when installed) on what each request changed, at the end of the turn; findings on added lines go back to the agent.',
    choices: [
      {value: 'off', label: 'Off  (default)'},
      {value: 'semgrep', label: 'Semgrep'},
    ],
  },
  {
    title: 'Planted instructions',
    group: 'Safety',
    key: 'injectionScan',
    description: 'Flag instructions planted in web pages, search results and MCP results: the agent is told they are data, and you see a warning.',
    choices: [
      {value: false, label: 'Off  (default)'},
      {value: true, label: 'On'},
    ],
  },
  {
    title: 'Data leaving',
    group: 'Safety',
    key: 'exfilGuard',
    description: 'Once a conversation has seen outside content and private data, calls that can send data out (web_fetch, MCP, curl, git push…) need your yes, even in bypass.',
    choices: [
      {value: false, label: 'Off  (default)'},
      {value: true, label: 'On'},
    ],
  },
  {
    title: 'MCP pinning',
    group: 'Safety',
    key: 'mcpPinning',
    description: "Remember each MCP server's config and tools when it first connects; if either changes, its tools are held until you accept it in /mcp.",
    choices: [
      {value: false, label: 'Off  (default)'},
      {value: true, label: 'On'},
    ],
  },
  {
    title: 'Dependencies',
    group: 'Safety',
    key: 'depCheck',
    description: 'Vet packages a change adds: does it exist, is it a typosquat, its license, known vulnerabilities (looked up on the registries and OSV).',
    choices: [
      {value: 'off', label: 'Off  (default)'},
      {value: 'warn', label: 'Warn — the change goes through and the agent is told'},
      {value: 'block', label: 'Block — the change is refused with the reasons'},
    ],
  },
];
export const GROUPS: Group[] = ['General', 'Agents', 'Accounts', 'Safety'];
export const TAB_TITLES = [...TABS.map((t) => t.title), ...GROUPS, 'Advanced'];
