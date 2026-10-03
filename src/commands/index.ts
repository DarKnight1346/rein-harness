import type {Skill} from '../skills/index.js';

export type CommandName = 'memory' | 'mcp' | 'rewind' | 'permissions' | 'add-dir' | 'goal' | 'btw' | 'agents' | 'agent' | 'resume' | 'login' | 'usage' | 'model' | 'context' | 'compact' | 'shells' | 'configure' | 'update' | 'tui' | 'clear' | 'help' | 'exit';

export const COMMANDS: {name: CommandName; description: string}[] = [
  {name: 'memory', description: "This project's memory (.rein/MEMORY.md) — what Rein has learned here"},
  {name: 'mcp', description: 'MCP servers: status and tools; approve project servers, reconnect'},
  {name: 'rewind', description: 'Undo: restore files and/or the conversation to before one of your messages (also esc twice)'},
  {name: 'permissions', description: 'Show the allow/deny rules in effect and where they come from'},
  {name: 'add-dir', description: 'Add a working directory the agent can use without asking: /add-dir <path> (no path: list them)'},
  {name: 'goal', description: 'Keep the agent on a goal until verified done: /goal <text> · pause · resume · clear'},
  {name: 'btw', description: 'Ask a side question without interrupting the agent (/btw <question>)'},
  {name: 'agents', description: 'Subagents the agent spawned; pick one to view and message it'},
  {name: 'agent', description: 'Switch the view: /agent <id> or /agent main (classic: /agent <id> <message>)'},
  {name: 'resume', description: 'Continue a saved conversation from this project'},
  {name: 'login', description: 'List signed-in accounts, add or remove accounts'},
  {name: 'usage', description: 'Usage windows (5h / weekly / …) and resets per account (/usage refresh)'},
  {name: 'model', description: 'Chat, decision and compaction models (/model auto, /model <name>)'},
  {name: 'context', description: 'Show what the current context holds and how full it is'},
  {name: 'compact', description: 'Summarize the conversation with the compaction model'},
  {name: 'shells', description: 'Shell commands the agent started; open one to see its logs (/shells <id>)'},
  {name: 'configure', description: 'Choose what the status line and sidebar show (alias /config)'},
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

const ALIASES: Record<string, CommandName> = {config: 'configure', settings: 'configure'};

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
