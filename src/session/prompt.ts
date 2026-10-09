import {existsSync} from 'node:fs';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {reinConfigDir} from '../store/paths.js';
import {memoryFacts} from '../tools/memory.js';
import {describeWorkspace, findWorkspace} from '../workspace/index.js';

const BASE_PROMPT = `You are Rein, a coding assistant working in the user's project from a terminal chat.
- Be direct and concise. Lead with the answer.
- Output renders as plain text in a terminal: prefer short paragraphs and simple lists; use code blocks for code.`;

const TOOLS_PROMPT = `# Tools
You have tools for working in the project: list, read, write, edit, delete, search, and shell (with shell_logs / shell_kill for background processes), plus web_search and web_fetch for the web, and image_generate for images when the user has Codex signed in.
- Paths are relative to the project root; absolute paths and ~/ work too.
- Inside the project (and any extra working directories) the tools work directly. Paths anywhere else need the user's approval per call (they may allow more for the session); credentials and secrets always ask. If a path is denied, ask instead of retrying.
- Read a file before editing it. Edit with exact, unique old_string values (no line-number prefixes); prefer edit over rewriting whole files.
- Use list to see what's in a folder and search to find code, before guessing at paths.
- shell runs commands in the project root (no stdin/TTY; use non-interactive flags). Use background: true for servers/watchers, then check shell_logs. Prefer read/search/edit over shell equivalents (cat, grep, sed).
- Skills (packaged instructions for specific tasks) are listed in the skill tool; when a request matches one, load it and follow it.
- For work with 3 or more distinct steps keep a task list with todo_write (one task in_progress at a time); skip it for smaller jobs. Update it as you go, several tasks in one call when they finish together.
- Every tool call is a round trip: batch them. Read several files in one call (read paths), make several changes in one call (edit edits), and issue independent calls together.
- write/edit/delete/shell may need the user's approval; if one is denied, ask how to proceed instead of retrying.`;

const MAX_AGENTS_BYTES = 64 * 1024;

/** Extra working directories (config / --add-dir), supplied by the runtime. */
let extraDirs: () => string[] = () => [];
export function setExtraWorkingDirs(fn: () => string[]): void {
  extraDirs = fn;
}

/** Provenance trailers on commits and PRs (config provenance), supplied by the runtime. */
let provenance: () => boolean = () => false;
export function setProvenance(fn: () => boolean): void {
  provenance = fn;
}

/** --scope: the monorepo package this session works in (absolute), supplied by the runtime. */
let scopeDir: () => string | undefined = () => undefined;
export function setScopeDir(fn: () => string | undefined): void {
  scopeDir = fn;
}

export const REIN_REPO = 'https://github.com/DarKnight1346/rein-harness';
export const ATTRIBUTION_LINE = `Co-Authored by [Rein Harness](${REIN_REPO})`;
/** Credit Rein in commits and pull requests (config `attribution`), supplied by the runtime. */
let attribution: () => boolean = () => true;
export function setAttribution(fn: () => boolean): void {
  attribution = fn;
}

/** brief-final is on (config `experiments`): a short final reply. */
let briefFinal: () => boolean = () => false;
export function setBriefFinal(fn: () => boolean): void {
  briefFinal = fn;
}
const BRIEF_PROMPT = `- When you've finished, reply in at most three short sentences: what changed, and anything the user must do or know. No recap of every file, no restating the request.`;

/** in-scope is on (config `experiments`): one line against work the request didn't ask for. */
let inScope: () => boolean = () => false;
export function setInScope(fn: () => boolean): void {
  inScope = fn;
}
const SCOPE_PROMPT = `- Do what was asked, completely, and no more: update the existing code and tests your change affects, but don't add new test files, refactors or features the request doesn't need. Extra work costs time and tokens.`;

/** self-test is on (config `experiments`), and always for Codex models: check your own change before finishing. */
let selfTest: () => boolean = () => false;
export function setSelfTest(fn: () => boolean): void {
  selfTest = fn;
}
// Codex's own instructions tell its models to test their work and Rein's replace them: under Rein, Sol ran
// a fifth as many commands as in Codex and handed work to subagents instead of checking it.
const SELF_TEST_PROMPT = `- Before you finish a code change, run the project's tests (or build) yourself and fix what fails. Do the work and the checking yourself; a subagent's report is not a test run.`;

/** many-calls is on (config `experiments`): many tool calls per response is the preferred way to work. */
let manyCalls: () => boolean = () => false;
export function setManyCalls(fn: () => boolean): void {
  manyCalls = fn;
}
const BATCH_LINE = '- Every tool call is a round trip: batch them.';
// Each round trip re-sends the whole conversation (cache reads were ~60% of a large task's cost), and
// 83-87% of requests carried a single tool call even with the line above.
const MANY_CALLS_PROMPT = `- Round trips are the main cost of a task: every response you send re-reads the whole conversation. Work in as few responses as you can by making MANY tool calls in each one. Plan the next several steps, then issue every call they need together: read all the files you'll need, run all the searches, make every edit you've decided on, and run independent commands (build, tests, greps, git) side by side. Five to ten calls in one response is normal and preferred. Calls in one response run in the order you write them, so you can make the edits and run the tests in the same response; wait for a result only when you need to read it before deciding the next call.`;

/** no-todo is on (config `experiments`): no task list tool, so the prompt doesn't mention it. */
let noTodo: () => boolean = () => false;
export function setNoTodo(fn: () => boolean): void {
  noTodo = fn;
}

/** lazy-tools is on (config `experiments`): rarely needed tools are reached through `tool`. */
let lazyTools: () => boolean = () => false;
export function setLazyTools(fn: () => boolean): void {
  lazyTools = fn;
}
const LAZY_PROMPT = `- Tools that aren't in your list (web_search, web_fetch, image_generate, agent, skill, decide, MCP servers, memory, past sessions) load on demand through tool: tool {name} shows what one takes, tool {name, args} runs it.`;

/** cheap-explore is on (config `experiments`): exploring goes to a cheap model through `explore`. */
let cheapExplore: () => boolean = () => false;
export function setCheapExplore(fn: () => boolean): void {
  cheapExplore = fn;
}
const EXPLORE_PROMPT = `- To find where something is or how existing code works, especially across many files, call explore first: a cheap model reads the code and reports file:line findings with short snippets, so you don't pay to carry every file it read. Then read only the lines you will change or must understand exactly.`;

/** Names in the secrets vault (never values), supplied by the runtime. */
let vaultNames: () => string[] = () => [];
export function setVaultNames(fn: () => string[]): void {
  vaultNames = fn;
}

/** Claude Code's user-level instructions (REIN_CLAUDE_GLOBAL overrides — tests). */
const claudeGlobal = () => process.env.REIN_CLAUDE_GLOBAL ?? path.join(os.homedir(), '.claude', 'CLAUDE.md');

/** Instruction files read per directory: the open standard plus Claude Code's. */
// CLAUDE.local.md: Claude Code's personal, uncommitted project instructions.
const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'];

/**
 * Instruction files, most general first: ~/.rein/AGENTS.md and ~/.claude/CLAUDE.md, then per
 * directory from the git root (or the filesystem root) down to the project root: AGENTS.md,
 * CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md. Duplicates (symlinks, identical copies) are included once. Each
 * becomes one section of the system prompt.
 */
export async function agentsFiles(cwd = process.cwd()): Promise<{path: string; text: string}[]> {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.unshift(dir);
    if (existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // A workspace's own instructions (next to rein.workspace.yaml) sit above every repo's.
  const ws = findWorkspace(cwd);
  const wsDirs = ws && !dirs.includes(ws.root) ? [ws.root] : [];
  const candidates = [path.join(reinConfigDir(), 'AGENTS.md'), claudeGlobal(), ...[...wsDirs, ...dirs].flatMap((d) => PROJECT_FILES.map((f) => path.join(d, f)))];
  const out: {path: string; text: string}[] = [];
  const seen = new Set<string>();
  for (const file of [...new Set(candidates)]) {
    const text = (await readFile(file, 'utf8').catch(() => '')).slice(0, MAX_AGENTS_BYTES).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({path: file, text});
  }
  return out;
}

/**
 * Rein's system prompt for chat sessions (all providers): base instructions (or
 * `~/.rein/system-prompt.md`), the tools section, the project root, and AGENTS.md files.
 */
export async function systemPrompt(opts: {tools?: boolean; scratch?: string; provider?: string} = {}): Promise<string> {
  let base = BASE_PROMPT;
  try {
    const custom = (await readFile(path.join(reinConfigDir(), 'system-prompt.md'), 'utf8')).trim();
    if (custom) base = custom;
  } catch {}
  const sections = [base];
  if (opts.tools) {
    const extra = extraDirs();
    let tools = noTodo() ? TOOLS_PROMPT.split('\n').filter((l) => !l.includes('todo_write')).join('\n') : TOOLS_PROMPT;
    if (manyCalls()) tools = tools.split('\n').map((l) => (l.startsWith(BATCH_LINE) ? MANY_CALLS_PROMPT : l)).join('\n');
    sections.push([tools, lazyTools() && LAZY_PROMPT, cheapExplore() && EXPLORE_PROMPT, inScope() && SCOPE_PROMPT, (selfTest() || opts.provider === 'codex') && SELF_TEST_PROMPT, briefFinal() && BRIEF_PROMPT].filter(Boolean).join('\n'));
    if (attribution())
      sections.push(
        [
          '# Commits and pull requests',
          `Every git commit you make must end with this line, after a blank line: ${ATTRIBUTION_LINE}`,
          `For example: git commit -m "Fix the date parser" -m "${ATTRIBUTION_LINE}"`,
          'Every pull request (or merge request) you open or edit ends its description with the same line, after a blank line.',
          "Use only this attribution line (no extra trailers for yourself) unless the user or the project's instructions ask for something else.",
        ].join('\n'),
      );
    if (provenance())
      sections.push(
        [
          '# Provenance',
          'End every git commit you make with these trailers, after a blank line, written exactly like this so the shell fills them in: -m "Rein-Session: $REIN_SESSION" -m "Rein-Model: $REIN_MODEL" and, when $REIN_GOAL is set, -m "Rein-Goal: $REIN_GOAL".',
          'Pull requests you open end their description with the same three lines (their values: echo $REIN_SESSION $REIN_MODEL $REIN_GOAL).',
        ].join('\n'),
      );
    sections.push(`Project root: ${process.cwd()}${extra.length ? `\nAlso working directories: ${extra.join(', ')}` : ''}`);
    const ws = findWorkspace();
    if (ws?.repos.length) sections.push(describeWorkspace(ws));
    const scope = scopeDir();
    if (scope)
      sections.push(
        `Scope: ${path.relative(process.cwd(), scope).split(path.sep).join('/')}/\nThe user is working on this package of the repo. list and search without a path, and shell without a cwd, start there. Keep your reading and changes inside it; go outside only when the task needs it (a shared type, a caller you broke) and say so.`,
      );
    if (opts.scratch) {
      sections.push(
        `Scratchpad: ${opts.scratch}\nA private folder for this session only. Put temporary files, notes, drafts and experiments here (absolute paths) instead of the project; changes there never need approval. It persists if the session is resumed.`,
      );
    }
    const secrets = vaultNames();
    if (secrets.length)
      sections.push(
        `Secrets vault: these environment variables are set in every shell command you run: ${secrets.map((n) => `$${n}`).join(', ')}. Use them by name (e.g. curl -H "Authorization: Bearer $${secrets[0]}"); you never see their values: anything that would show one (command output, files) shows [secret:NAME] instead. Tools that read the environment (gh, npm, aws…) pick them up as usual.`,
      );
    sections.push('Past conversations in this project can be searched with sessions_search and read with session_read.');
    sections.push('If an advisor tool is available, it consults a stronger, expensive model: use it sparingly for important decisions or when stuck.');
  }
  // Project memory (.rein/MEMORY.md): what earlier sessions learned here.
  const facts = memoryFacts(process.cwd());
  if (opts.tools) {
    sections.push(
      facts.length
        ? `# Project memory (.rein/MEMORY.md)\nLearned in earlier sessions on this project — rely on it, keep it current with remember / forget:\n${facts.map((f) => `- ${f}`).join('\n')}`
        : '# Project memory\nEmpty so far. When you learn something lasting about this project (commands, conventions, decisions, gotchas), save it with remember.',
    );
  }
  for (const f of await agentsFiles(scopeDir() ?? process.cwd())) {
    sections.push(`# Project instructions (${f.path})\nFollow these instructions from ${path.basename(f.path)}:\n\n${f.text}`);
  }
  return sections.join('\n\n');
}

/**
 * Instruction files for a subfolder the agent just worked in, below the launch folder (those
 * above it are in the system prompt). Each comes with its scope: it applies only to files under
 * its own folder. `delivered` (absolute paths) keeps each file to once per conversation.
 */
export function scopedInstructions(root: string, dir: string, delivered: Set<string>): {path: string; scope: string; text: string}[] {
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return [];
  const out: {path: string; scope: string; text: string}[] = [];
  const parts = rel.split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    const d = path.join(root, ...parts.slice(0, i));
    for (const f of PROJECT_FILES) {
      const file = path.join(d, f);
      if (delivered.has(file)) continue;
      let text = '';
      try {
        text = readFileSync(file, 'utf8').slice(0, MAX_AGENTS_BYTES).trim();
      } catch {
        continue;
      }
      delivered.add(file);
      if (!text || out.some((o) => o.text === text)) continue;
      const scope = parts.slice(0, i).join('/') + '/';
      out.push({path: path.relative(root, file).split(path.sep).join('/'), scope, text});
    }
  }
  return out;
}

/** How scoped instructions are shown to the model (appended to the tool result that found them). */
export const renderScoped = (items: {path: string; scope: string; text: string}[]) =>
  items
    .map((i) => `<scoped_instructions file="${i.path}" applies_to="${i.scope}">\nThese instructions apply ONLY to files under ${i.scope} — follow them when working there, not elsewhere.\n\n${i.text}\n</scoped_instructions>`)
    .join('\n\n');
