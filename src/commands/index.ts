import type {Skill} from '../skills/index.js';

export type CommandName = 'trackers' | 'remote' | 'voice' | 'vault' | 'lsp' | 'plugins' | 'export' | 'ide' | 'memory' | 'mcp' | 'rewind' | 'permissions' | 'add-dir' | 'workspace' | 'owners' | 'refs' | 'symbols' | 'services' | 'sessions' | 'env' | 'schedule' | 'cache' | 'stats' | 'deadcode' | 'flags' | 'migrations' | 'contracts' | 'bestof' | 'risk' | 'arch' | 'adr' | 'spec' | 'index' | 'map' | 'pack' | 'pr' | 'mutate' | 'coverage' | 'ci' | 'build' | 'flaky' | 'affected' | 'policy' | 'cost' | 'scope' | 'goal' | 'goal:plan' | 'btw' | 'agents' | 'agent' | 'resume' | 'login' | 'usage' | 'model' | 'context' | 'compact' | 'shells' | 'settings' | 'update' | 'tui' | 'clear' | 'help' | 'exit';

export const COMMANDS: {name: CommandName; description: string}[] = [
  {name: 'remote', description: 'Use this session from your phone or another computer: a page Rein serves (pairing code); /remote pair · status · unpair · off'},
  {name: 'trackers', description: 'Issue trackers handing work to Rein (GitHub, Linear, GitLab, Azure DevOps, Jira): status · check · retry <ref>'},
  {name: 'voice', description: 'Voice input, on your machine (whisper.cpp): hold Ctrl+Space to talk. /voice shows status or starts/stops recording; /voice setup installs what it needs'},
  {name: 'vault', description: 'Secrets the agent can use in shell commands as $NAME without seeing them: list, /vault set NAME, /vault rm NAME'},
  {name: 'lsp', description: "Built-in code intelligence: the language servers Rein runs, their memory, what's installed (/lsp stop stops them)"},
  {name: 'plugins', description: 'Installed Claude Code and Codex plugins Rein loaded: their commands, skills, agents, hooks and MCP servers'},
  {name: 'export', description: 'Save the conversation as Markdown and copy it to the clipboard: /export [file] (default ~/.rein/exports/<id>.md); /export html [file] for a page with tool calls and diffs'},
  {name: 'ide', description: 'Editor integration (VS Code, Cursor, Windsurf, JetBrains with the Claude Code extension): connect, or show the connection'},
  {name: 'memory', description: "This project's memory (.rein/MEMORY.md) — what Rein has learned here"},
  {name: 'mcp', description: 'MCP servers: status and tools; approve project servers, reconnect'},
  {name: 'rewind', description: 'Undo: restore files and/or the conversation to before one of your messages (also esc twice)'},
  {name: 'permissions', description: 'Show the allow/deny rules in effect and where they come from'},
  {name: 'cost', description: 'What this conversation, the latest request and the goal cost at API list prices'},
  {name: 'policy', description: 'The policy in force here (.rein/policy.yaml, ~/.rein/policy.yaml): its rules, allowed models and any mistakes in the files'},
  {name: 'affected', description: "What your changes affect, from the monorepo's build graph (Nx, Turborepo, Bazel, Pants), and the command that tests just that"},
  {name: 'flaky', description: 'Tests known to be flaky here (they failed and passed on the same code): /flaky lists them, /flaky clear forgets them'},
  {name: 'build', description: 'The build system here (Nx, Turborepo, Bazel, Pants), its caches, and whether the sandbox lets agent builds use them'},
  {name: 'ci', description: "This branch's pull request checks: /ci shows them, /ci watch fixes failures as they come (asks before pushing), /ci stop"},
  {name: 'coverage', description: 'Lines your changes add that no test covers, from the last coverage report; /coverage tests asks the agent to write tests for them'},
  {name: 'mutate', description: 'Mutation testing of your changed files (Stryker, mutmut, go-mutesting): do the tests catch planted bugs? /mutate tests asks the agent to close the gaps'},
  {name: 'pr', description: "This branch's pull request: /pr (status), /pr digest [post], /pr split, /pr comments, /pr queue [yes]"},
  {name: 'pack', description: 'Context packs (.rein/packs.yaml): /pack lists them, /pack <name> [message] attaches one, /pack save <name> <globs…> makes one'},
  {name: 'refs', description: 'Follow an endpoint (POST /orders/{id}) or RPC (Ledger.Post) across repos: gateway, the service that serves it, every caller'},
  {name: 'symbols', description: 'Symbols across repos from their SCIP indexes: /symbols <name> (definition and every use), /symbols cross (used outside their repo), /symbols index'},
  {name: 'services', description: 'Which service calls which, from compose, Kubernetes, URLs, gRPC clients and packages: /services, /services mermaid'},
  {name: 'sessions', description: 'Every running Rein on this machine, across repos: state, folder, goal. /sessions send <pid> <message> steers one; rein sessions is the full dashboard'},
  {name: 'env', description: "The dev environment the agent's commands run in (dev container, Nix, devbox): /env shows it, /env up starts it now"},
  {name: 'schedule', description: 'Scheduled jobs in .rein/schedule.yaml: when each runs next and how the last run went (rein schedule install runs them on time)'},
  {name: 'cache', description: 'Prompt-cache hit rates per model, and what made the cache cold: /cache [days] [all]'},
  {name: 'stats', description: 'How your requests go, from saved conversations: time, tool calls, failures, retries, tests passed and cost, per model: /stats [days] [all]'},
  {name: 'deadcode', description: 'Definitions nothing refers to (JS/TS, Python, Go): /deadcode lists them, /deadcode remove has the agent delete them'},
  {name: 'flags', description: 'Feature flags the code reads, and the stale ones (fully on or off, or older than 90 days): /flags, /flags remove <key>'},
  {name: 'migrations', description: "Risks in this branch's database migrations: locks, missing backfills, irreversible steps, renames that break running code"},
  {name: 'contracts', description: 'Breaking and safe changes to API contracts (OpenAPI, protobuf, GraphQL, Avro) on this branch'},
  {name: 'bestof', description: 'Run a task on Claude and Codex at once, each in its own worktree; keep the result that passes the tests: /bestof [--test "<command>"] <task>'},
  {name: 'risk', description: "What a plan touches: files, services, owners, contracts and migrations. /risk [plan file or spec name] (default: the newest plan)"},
  {name: 'arch', description: 'Architecture rules (.rein/architecture.yaml): /arch checks every file against them'},
  {name: 'adr', description: 'Architecture decision records: /adr lists them, /adr new <title> starts the next one'},
  {name: 'spec', description: 'Spec mode: requirements, design, then tasks, each approved; /spec <what>, /spec resume <name>, /spec trace <name>, /spec lists them'},
  {name: 'index', description: 'Build or update the local semantic index (Ollama) for search by meaning: /index, /index <query> to search it, /index status'},
  {name: 'map', description: "A map of the repo's declarations, file by file: /map shows it, /map send gives it to the agent"},
  {name: 'owners', description: 'Who owns your changed files (or a path): CODEOWNERS, Backstage, then git history'},
  {name: 'workspace', description: 'The repos of this workspace (rein.workspace.yaml): /workspace lists them, /workspace clone clones the missing ones, /workspace prs and link-prs link the PRs of one change'},
  {name: 'scope', description: 'Work in one package of a monorepo: /scope <dir> (search, list, shell and instructions start there), /scope off, or no argument to show it'},
  {name: 'add-dir', description: 'Add a working directory the agent can use without asking: /add-dir <path> (no path: list them)'},
  {name: 'goal:plan', description: 'Start a saved plan as a goal (milestones tracked in the sidebar), or start planning a new one'},
  {name: 'goal', description: 'Keep the agent on a goal until verified done: /goal <text> · pause · resume · clear'},
  {name: 'btw', description: 'Ask a side question without interrupting the agent (/btw <question>)'},
  {name: 'agents', description: 'Subagents the agent spawned; pick one to view and message it'},
  {name: 'agent', description: 'Switch the view: /agent <id> or /agent main (classic: /agent <id> <message>)'},
  {name: 'resume', description: 'Continue a saved conversation from this project'},
  {name: 'login', description: 'List signed-in accounts, add or remove accounts'},
  {name: 'usage', description: 'Usage windows (5h / weekly / …) and resets per account (/usage refresh)'},
  {name: 'model', description: 'Chat, decision and compaction models (/model auto, /model <name>)'},
  {name: 'context', description: 'Show what the current context holds and how full it is'},
  {name: 'compact', description: 'Summarize the conversation with the compaction model; /compact <what to keep> focuses the summary'},
  {name: 'shells', description: 'Shell commands the agent started; open one to see its logs (/shells <id>)'},
  {name: 'settings', description: 'Settings in tabs (General, Agents, Accounts, Safety, layout, Advanced): /settings [tab]; /settings <key> [value] for any key'},
  {name: 'update', description: 'Update the claude and codex CLIs and Rein'},
  {name: 'tui', description: 'Switch renderer: /tui fullscreen or /tui classic'},
  {name: 'clear', description: 'Clear the conversation'},
  {name: 'help', description: 'Show commands'},
  {name: 'exit', description: 'Quit'},
];

export type Parsed =
  | {kind: 'command'; name: CommandName; args: string}
  | {kind: 'skill'; skill: Skill; args: string}
  | {kind: 'unknown'; name: string}
  | {kind: 'text'; text: string};

/** An autocomplete row: a built-in command or a skill. */
export type Suggestion = {name: string; description: string; skill?: Skill};

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
  const skill = findSkill(skills, head);
  return skill ? {kind: 'skill', skill, args: rest.join(' ')} : {kind: 'unknown', name: head};
}

/** Commands matching what's typed so far: shown while the input is `/` + a partial name (no space yet). */
export function suggestCommands(input: string, skills: Skill[] = []): Suggestion[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const q = input.slice(1).toLowerCase();
  const shadowed = new Set(shadowedSkills(skills).map((s) => s.name));
  return [
    ...COMMANDS.filter((c) => c.name.startsWith(q)),
    ...skills
      .filter((s) => !shadowed.has(s.name) && (s.name.startsWith(q) || s.aliases.some((a) => a.startsWith(q))))
      .map((s) => ({name: s.name, description: s.description + (s.aliases.length ? ` (alias: ${s.aliases.map((a) => `/${a}`).join(', ')})` : ''), skill: s})),
  ];
}
