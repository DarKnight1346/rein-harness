import {existsSync} from 'node:fs';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {reinConfigDir} from '../store/paths.js';
import {memoryFacts} from '../tools/memory.js';

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
- For multi-step work keep a task list with todo_write (one task in_progress at a time; mark tasks completed as you finish them).
- write/edit/delete/shell may need the user's approval; if one is denied, ask how to proceed instead of retrying.`;

const MAX_AGENTS_BYTES = 64 * 1024;

/** Extra working directories (config / --add-dir), supplied by the runtime. */
let extraDirs: () => string[] = () => [];
export function setExtraWorkingDirs(fn: () => string[]): void {
  extraDirs = fn;
}

export const REIN_REPO = 'https://github.com/DarKnight1346/rein-harness';
export const ATTRIBUTION_LINE = `Co-Authored by [Rein Harness](${REIN_REPO})`;
/** Credit Rein in commits and pull requests (config `attribution`), supplied by the runtime. */
let attribution: () => boolean = () => true;
export function setAttribution(fn: () => boolean): void {
  attribution = fn;
}

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
  const candidates = [path.join(reinConfigDir(), 'AGENTS.md'), claudeGlobal(), ...dirs.flatMap((d) => PROJECT_FILES.map((f) => path.join(d, f)))];
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
export async function systemPrompt(opts: {tools?: boolean; scratch?: string} = {}): Promise<string> {
  let base = BASE_PROMPT;
  try {
    const custom = (await readFile(path.join(reinConfigDir(), 'system-prompt.md'), 'utf8')).trim();
    if (custom) base = custom;
  } catch {}
  const sections = [base];
  if (opts.tools) {
    const extra = extraDirs();
    sections.push(TOOLS_PROMPT);
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
    sections.push(`Project root: ${process.cwd()}${extra.length ? `\nAlso working directories: ${extra.join(', ')}` : ''}`);
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
  for (const f of await agentsFiles()) {
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
