import type {Skill} from '../skills/index.js';

export type CommandName = 'marketplace' | 'pet' | 'trackers' | 'remote' | 'voice' | 'vault' | 'lsp' | 'plugins' | 'export' | 'ide' | 'memory' | 'mcp' | 'rewind' | 'permissions' | 'add-dir' | 'workspace' | 'owners' | 'sessions' | 'env' | 'schedule' | 'cache' | 'stats' | 'bestof' | 'risk' | 'arch' | 'adr' | 'spec' | 'index' | 'map' | 'pack' | 'pr' | 'ci' | 'flaky' | 'policy' | 'cost' | 'scope' | 'goal' | 'goal:plan' | 'btw' | 'agents' | 'agent' | 'resume' | 'login' | 'usage' | 'model' | 'context' | 'compact' | 'shells' | 'settings' | 'update' | 'tui' | 'clear' | 'help' | 'exit';

/**
 * Built-in commands, in the order the `/` list shows them (everyday ones first). `description` is
 * the short line in that list; `usage` the full line with arguments, in /help. `listed: false`:
 * variants and diagnostics, left out of a bare `/` and found by typing part of the name.
 */
export type Command = {name: CommandName; description: string; usage: string; listed?: false};
export const COMMANDS: Command[] = [
  {name: 'model', description: 'Pick the chat model, or auto', usage: 'Chat, decision and compaction models (/model auto, /model <name>)'},
  {name: 'goal', description: "Keep working on a goal until it's verified done", usage: 'Keep the agent on a goal until verified done: /goal <text> · pause · resume · clear'},
  {name: 'btw', description: 'Ask a side question without interrupting', usage: 'Ask a side question without interrupting the agent (/btw <question>)'},
  {name: 'compact', description: 'Summarize the conversation to free up context', usage: 'Summarize the conversation with the compaction model; /compact <what to keep> focuses the summary'},
  {name: 'context', description: "What's in the context and how full it is", usage: 'Show what the current context holds and how full it is'},
  {name: 'cost', description: 'What this conversation has cost', usage: 'What this conversation, the latest request and the goal cost at API list prices'},
  {name: 'usage', description: 'Usage limits and resets, per account', usage: 'Usage windows (5h / weekly / …) and resets per account (/usage refresh)'},
  {name: 'resume', description: 'Continue a saved conversation', usage: 'Continue a saved conversation from this project'},
  {name: 'rewind', description: 'Undo back to before one of your messages', usage: 'Undo: restore files and/or the conversation to before one of your messages (also esc twice)'},
  {name: 'clear', description: 'Start a new conversation', usage: 'Clear the conversation'},
  {name: 'agents', description: 'Subagents: watch and message them', usage: 'Subagents the agent spawned; pick one to view and message it'},
  {name: 'shells', description: 'Commands the agent started, and their output', usage: 'Shell commands the agent started; open one to see its logs (/shells <id>)'},
  {name: 'memory', description: 'What Rein has learned about this project', usage: "This project's memory (.rein/MEMORY.md) — what Rein has learned here"},
  {name: 'marketplace', description: 'Add tools, commands, skills and themes', usage: 'The marketplace: /marketplace opens the store; add <gitRepoUrl> · list · remove <gitRepoUrl> · update [all | <id>…] · install <id> · uninstall <id>'},
  {name: 'mcp', description: 'MCP servers and their tools', usage: 'MCP servers: status and tools; approve project servers, reconnect'},
  {name: 'export', description: 'Save the conversation as Markdown or HTML', usage: 'Save the conversation as Markdown and copy it to the clipboard: /export [file] (default ~/.rein/exports/<id>.md); /export html [file] for a page with tool calls and diffs'},
  {name: 'ide', description: 'Connect to your editor', usage: 'Editor integration (VS Code, Cursor, Windsurf, JetBrains with the Claude Code extension): connect, or show the connection'},
  {name: 'remote', description: 'Use this session from your phone', usage: 'Use this session from your phone or another computer: a page Rein serves (pairing code); /remote pair · status · unpair · off'},
  {name: 'pet', description: 'Your pet, in the sidebar', usage: 'Your pet, in the sidebar: /pet lists yours, /pet <name> picks one, /pet add <sheet> [name] adds one, /pet off hides it, /pet refresh'},
  {name: 'add-dir', description: 'Let the agent work in another folder', usage: 'Add a working directory the agent can use without asking: /add-dir <path> (no path: list them)'},
  {name: 'permissions', description: 'The allow and deny rules in effect', usage: 'Show the allow/deny rules in effect and where they come from'},
  {name: 'vault', description: 'Secrets the agent can use without seeing them', usage: 'Secrets the agent can use in shell commands as $NAME without seeing them: list, /vault set NAME, /vault rm NAME'},
  {name: 'login', description: 'Add or remove accounts', usage: 'List signed-in accounts, add or remove accounts'},
  {name: 'settings', description: 'Settings', usage: 'Settings in tabs (Status line, Sidebar, General, Agents, Accounts, Safety, Packs, Advanced): /settings [tab]; /settings <key> [value] for any key'},
  {name: 'update', description: 'Update Rein and the claude and codex CLIs', usage: 'Update the claude and codex CLIs and Rein'},
  {name: 'help', description: 'Every command, and the keys', usage: 'Show commands'},
  {name: 'exit', description: 'Quit', usage: 'Quit'},
  {name: 'goal:plan', description: 'Start a saved plan as a goal', usage: 'Start a saved plan as a goal (milestones tracked in the sidebar), or start planning a new one', listed: false},
  {name: 'agent', description: 'Switch the view to a subagent, or back to main', usage: 'Switch the view: /agent <id> or /agent main (classic: /agent <id> <message>)', listed: false},
  {name: 'tui', description: 'Switch between fullscreen and classic', usage: 'Switch renderer: /tui fullscreen or /tui classic', listed: false},
  {name: 'voice', description: 'Voice input, on your machine', usage: 'Voice input, on your machine (whisper.cpp): hold Ctrl+Space to talk. /voice shows status or starts/stops recording; /voice setup installs what it needs', listed: false},
  {name: 'lsp', description: 'The language servers Rein runs', usage: "Built-in code intelligence: the language servers Rein runs, their memory, what's installed (/lsp stop stops them)", listed: false},
  {name: 'plugins', description: 'Claude Code and Codex plugins Rein loaded', usage: 'Installed Claude Code and Codex plugins Rein loaded: their commands, skills, agents, hooks and MCP servers', listed: false},
  {name: 'ci', description: 'Pull request checks, and fixing failures as they come', usage: "This branch's pull request checks: /ci shows them, /ci watch fixes failures as they come (asks before pushing), /ci stop", listed: false},
  {name: 'pr', description: "This branch's pull request: status, digest, split, comments", usage: "This branch's pull request: /pr (status), /pr digest [post], /pr split, /pr comments, /pr queue [yes]", listed: false},
  {name: 'flaky', description: 'Tests known to be flaky here', usage: 'Tests known to be flaky here (they failed and passed on the same code): /flaky lists them, /flaky clear forgets them', listed: false},
  {name: 'trackers', description: 'Issue trackers handing work to Rein', usage: 'Issue trackers handing work to Rein (GitHub, Linear, GitLab, Azure DevOps, Jira): status · check · retry <ref>', listed: false},
  {name: 'spec', description: 'Spec mode: requirements, design, then tasks', usage: 'Spec mode: requirements, design, then tasks, each approved; /spec <what>, /spec resume <name>, /spec trace <name>, /spec lists them', listed: false},
  {name: 'adr', description: 'Architecture decision records', usage: 'Architecture decision records: /adr lists them, /adr new <title> starts the next one', listed: false},
  {name: 'arch', description: 'Check the code against the architecture rules', usage: 'Architecture rules (.rein/architecture.yaml): /arch checks every file against them', listed: false},
  {name: 'risk', description: 'What a plan touches, and how risky it is', usage: "What a plan touches: files, services, owners, contracts and migrations. /risk [plan file or spec name] (default: the newest plan)", listed: false},
  {name: 'bestof', description: 'Run a task on Claude and Codex at once; keep what passes', usage: 'Run a task on Claude and Codex at once, each in its own worktree; keep the result that passes the tests: /bestof [--test "<command>"] <task>', listed: false},
  {name: 'workspace', description: 'The repos of this workspace', usage: 'The repos of this workspace (rein.workspace.yaml): /workspace lists them, /workspace clone clones the missing ones, /workspace prs and link-prs link the PRs of one change', listed: false},
  {name: 'scope', description: 'Work in one package of a monorepo', usage: 'Work in one package of a monorepo: /scope <dir> (search, list, shell and instructions start there), /scope off, or no argument to show it', listed: false},
  {name: 'owners', description: 'Who owns your changed files', usage: 'Who owns your changed files (or a path): CODEOWNERS, Backstage, then git history', listed: false},
  {name: 'index', description: 'The semantic index, for search by meaning', usage: 'Build or update the local semantic index (Ollama) for search by meaning: /index, /index <query> to search it, /index status', listed: false},
  {name: 'map', description: "A map of the repo's declarations", usage: "A map of the repo's declarations, file by file: /map shows it, /map send gives it to the agent", listed: false},
  {name: 'pack', description: 'Context packs to attach to a message', usage: 'Context packs (.rein/packs.yaml): /pack lists them, /pack <name> [message] attaches one, /pack save <name> <globs…> makes one', listed: false},
  {name: 'stats', description: 'How your requests go: time, tools, failures and cost', usage: 'How your requests go, from saved conversations: time, tool calls, failures, retries, tests passed and cost, per model: /stats [days] [all]', listed: false},
  {name: 'cache', description: 'Prompt-cache hit rates, and what made it cold', usage: 'Prompt-cache hit rates per model, and what made the cache cold: /cache [days] [all]', listed: false},
  {name: 'schedule', description: 'Scheduled jobs', usage: 'Scheduled jobs in .rein/schedule.yaml: when each runs next and how the last run went (rein schedule install runs them on time)', listed: false},
  {name: 'env', description: "The dev environment the agent's commands run in", usage: "The dev environment the agent's commands run in (dev container, Nix, devbox): /env shows it, /env up starts it now", listed: false},
  {name: 'sessions', description: 'Every Rein running on this machine', usage: 'Every running Rein on this machine, across repos: state, folder, goal. /sessions send <pid> <message> steers one; rein sessions is the full dashboard', listed: false},
  {name: 'policy', description: 'The policy in force here', usage: 'The policy in force here (.rein/policy.yaml, ~/.rein/policy.yaml): its rules, allowed models and any mistakes in the files', listed: false},
];

export type Parsed =
  | {kind: 'command'; name: CommandName; args: string}
  | {kind: 'extension'; command: ExtensionCommand; args: string}
  | {kind: 'skill'; skill: Skill; args: string}
  | {kind: 'unknown'; name: string}
  | {kind: 'text'; text: string};

/** An autocomplete row: a built-in command, a marketplace item's command, or a skill. */
export type Suggestion = {name: string; description: string; skill?: Skill; extension?: ExtensionCommand};

/** A command a marketplace item's code registered (extensions/index.ts). */
export type ExtensionCommand = import('../extensions/api.js').Command;
let extensionCommands: () => ExtensionCommand[] = () => [];
/** The runtime says which commands installed items have (set at startup; read on every keystroke). */
export function setExtensionCommands(fn: () => ExtensionCommand[]): void {
  extensionCommands = fn;
}
/** Item commands Rein's own don't shadow. */
const itemCommands = () => extensionCommands().filter((c) => !COMMANDS.some((b) => b.name === c.name));

const ALIASES: Record<string, CommandName> = {};

/** Built-in commands win over skills with the same name. */
export const shadowedSkills = (skills: Skill[]) => skills.filter((s) => isCommandName(s.name));
const isCommandName = (n: string) => COMMANDS.some((c) => c.name === n) || n in ALIASES;

/** Skill by name, else by alias (an alias never beats a real skill name or a built-in command). */
export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const n = name.toLowerCase();
  if (isCommandName(n)) return undefined;
  return skills.find((s) => s.name === n) ?? skills.find((s) => s.aliases.includes(n) && !skills.some((o) => o.name === n));
}

export function parseInput(raw: string, skills: Skill[] = []): Parsed | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (!text.startsWith('/')) return {kind: 'text', text};
  const [head = '', ...rest] = text.slice(1).split(/\s+/);
  const name = ALIASES[head.toLowerCase()] ?? head.toLowerCase();
  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd) return {kind: 'command', name: cmd.name, args: rest.join(' ')};
  const ext = itemCommands().find((c) => c.name === name);
  if (ext) return {kind: 'extension', command: ext, args: rest.join(' ')};
  const skill = findSkill(skills, head);
  return skill ? {kind: 'skill', skill, args: rest.join(' ')} : {kind: 'unknown', name: head};
}

/**
 * How well `q` matches `name` (higher is better; undefined = no match): exact, then prefix, then the
 * start of a word (`fork` → `btw:fork`), then anywhere, then the letters in order (`cmpct` →
 * `compact`), scored by how close together and how near word starts they fall.
 */
export function fuzzyScore(q: string, name: string): number | undefined {
  if (!q) return 0;
  if (name === q) return 10_000;
  if (name.startsWith(q)) return 9_000; // ties keep the list's order
  const word = name.search(new RegExp(`[-:_./]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  if (word >= 0) return 8_000 - word - name.length;
  const at = name.indexOf(q);
  if (at >= 0) return 7_000 - at * 10 - name.length;
  let score = 5_000;
  let from = 0;
  let last = -1;
  for (const ch of q) {
    const i = name.indexOf(ch, from);
    if (i < 0) return undefined;
    if (last >= 0) score -= (i - last - 1) * 10; // a gap between matched letters
    if (i === 0 || /[-:_./]/.test(name[i - 1]!)) score += 15; // a word start
    last = i;
    from = i + 1;
  }
  return score - name.length;
}

/**
 * Commands matching what's typed so far, best match first: shown while the input is `/` + a
 * partial name (no space yet). Names and aliases match fuzzily; a description only on a whole
 * substring, below every name match.
 */
export function suggestCommands(input: string, skills: Skill[] = []): Suggestion[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const q = input.slice(1).toLowerCase();
  const shadowed = new Set(shadowedSkills(skills).map((s) => s.name));
  const all: (Suggestion & {names: string[]})[] = [
    ...COMMANDS.map((c) => ({...c, names: [c.name, ...Object.keys(ALIASES).filter((a) => ALIASES[a] === c.name)]})),
    ...itemCommands().map((c) => ({name: c.name, description: c.description, extension: c, names: [c.name], ...(c.listed === false ? {listed: false as const} : {})})),
    ...skills
      .filter((s) => !shadowed.has(s.name))
      .map((s) => ({name: s.name, description: s.description + (s.aliases.length ? ` (alias: ${s.aliases.map((a) => `/${a}`).join(', ')})` : ''), skill: s, names: [s.name, ...s.aliases]})),
  ];
  if (!q) {
    // A bare `/`: listed commands, with Rein's own everyday skills (/plan, /review, /init) after
    // /goal, then the project's and your own. Variants, and skills from Codex and other tools'
    // plugins, wait until you type part of their name.
    const listed = all.filter((c) => (c.skill ? c.skill.listed !== false && (c.skill.marketplace || (c.skill.source !== 'plugin' && c.skill.source !== 'codex')) : (c as {listed?: false}).listed !== false));
    const rank = (n: string) => ((i) => (i < 0 ? 99 : i))(['plan', 'review', 'init'].indexOf(n));
    const builtin = listed.filter((c) => c.skill?.source === 'builtin').sort((a, b) => rank(a.name) - rank(b.name));
    const commands = listed.filter((c) => !c.skill);
    const at = commands.findIndex((c) => c.name === 'goal') + 1;
    return [...commands.slice(0, at), ...builtin, ...commands.slice(at), ...listed.filter((c) => c.skill && c.skill.source !== 'builtin')].map(({names: _, ...c}) => c);
  }
  const scored = all
    .map((c, order) => {
      const names = c.names.map((n) => fuzzyScore(q, n.toLowerCase())).filter((x): x is number => x !== undefined);
      const score = names.length ? Math.max(...names) : q.length >= 3 && c.description.toLowerCase().includes(q) ? 1_000 : undefined;
      return {c, order, score};
    })
    .filter((x): x is typeof x & {score: number} => x.score !== undefined);
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map(({c: {names: _, ...c}}) => c);
}
