import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {builtinSkillEnabled} from '../commands/packs.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {reinConfigDir} from '../store/paths.js';
import {codexSkillRoots, loadPlugins, pluginVars} from '../plugins/index.js';

/** `claude-project` / `claude-user`: Claude Code custom commands (`.claude/commands/*.md`), run as skills. */
/** `plugin`: from an installed Claude Code / Codex plugin; `codex`: a Codex skill (~/.codex/skills, .agents/skills). */
export type SkillSource = 'builtin' | 'project' | 'global' | 'claude-project' | 'claude-user' | 'plugin' | 'codex';

/** How a skill's origin reads in the UI. */
export const skillSourceLabel = (s: SkillSource) =>
  ({builtin: 'built-in skill', project: 'project skill', global: 'global skill', 'claude-project': 'Claude Code command (project)', 'claude-user': 'Claude Code command', plugin: 'plugin', codex: 'Codex skill'})[s];

export type Skill = {
  name: string;
  description: string;
  source: SkillSource;
  /** The skill's folder (SKILL.md plus any scripts/assets it carries). */
  dir: string;
  path: string;
  /** Instructions (SKILL.md without frontmatter). */
  body: string;
  /** Files in the folder, relative (capped, main file first), so the agent knows what it can run/read. */
  files: string[];
  /** Extra slash names from config.json (`/sc` → skill:create). */
  aliases: string[];
  /** config.json "planMode": true — running the skill turns plan mode on (/plan, /plan:deep). */
  planMode?: boolean;
  /** config.json "listed": false — left out of a bare `/` list (a variant like /plan:deep); typing finds it. */
  listed?: false;
  /** Claude Code command frontmatter `argument-hint` (shown in the command list). */
  argumentHint?: string;
  /** A Claude Code-style command (`$ARGUMENTS`, `!`cmd``), not a skill folder. */
  command?: boolean;
  /** The plugin it comes from. */
  plugin?: string;
};

/**
 * Optional `<skill>/config.json`: `{"name"?, "description"?, "main"?: "PROMPT.md", "aliases"?: ["sc"]}`.
 * Each field falls back: config.json → the main file's frontmatter → defaults (main `SKILL.md`, the
 * folder name, the first line of the instructions). A missing `main` file falls back to SKILL.md.
 */
type SkillConfig = {name?: string; description?: string; main?: string; aliases?: string[]; planMode?: boolean; listed?: boolean};

/** Rein's own skills ship in `<install>/skills` (works from src/ via tsx and from dist/). */
export const builtinSkillsDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

export const skillDirs = (cwd = process.cwd()) => ({
  builtin: builtinSkillsDir(),
  global: path.join(reinConfigDir(), 'skills'),
  project: path.join(cwd, '.rein', 'skills'),
});

/** `---\nname: x\ndescription: y\n---\nbody` → fields + body (frontmatter optional). */
export function parseSkillFile(text: string): {fields: Record<string, string>; body: string} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return {fields: {}, body: text.trim()};
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return {fields, body: text.slice(m[0].length).trim()};
}

/** Slash-command-safe name: lowercase letters/digits/-/_, plus `:` for namespaces (`skill:create`). */
export const skillName = (raw: string) => raw.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, '-').replace(/^[-:]+|[-:]+$/g, '');

const MAX_FILES = 50;

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || out.length >= MAX_FILES) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(path.join(dir, e.name), rel).slice(0, MAX_FILES - out.length));
    else out.push(rel);
  }
  return out;
}

function readConfig(dir: string): SkillConfig {
  try {
    const c = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

/** Skills in one root: every sub-folder with its main file (config.json `main`, else SKILL.md). */
function scan(root: string, source: SkillSource): Skill[] {
  if (!existsSync(root)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith('.')) continue; // e.g. Codex's own .system skills
    const dir = path.join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const config = readConfig(dir);
    const candidates = [...(typeof config.main === 'string' ? [config.main] : []), 'SKILL.md', 'skill.md'];
    const file = candidates.map((f) => path.resolve(dir, f)).find((f) => f.startsWith(dir + path.sep) && existsSync(f));
    if (!file) continue;
    const {fields, body} = parseSkillFile(readFileSync(file, 'utf8'));
    const name = skillName(config.name ?? fields.name ?? entry);
    if (!name || !body) continue;
    const main = path.relative(dir, file);
    out.push({
      name,
      description: config.description || fields.description || firstLine(body),
      source,
      dir,
      path: file,
      body,
      files: [main, ...listFiles(dir).filter((f) => f !== main)].slice(0, MAX_FILES),
      aliases: (Array.isArray(config.aliases) ? config.aliases : []).map((a) => skillName(String(a))).filter((a) => a && a !== name),
      ...(config.planMode === true ? {planMode: true} : {}),
      ...(config.listed === false ? {listed: false as const} : {}),
    });
  }
  return out;
}

/** Commands and skills from installed plugins, as `/<plugin>:<name>`. */
function pluginSkills(cwd: string): Skill[] {
  const out: Skill[] = [];
  for (const p of loadPlugins(cwd)) {
    for (const file of p.commands) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const {fields, body} = parseSkillFile(pluginVars(text, p));
      const name = skillName(`${p.name}:${path.basename(file, '.md')}`);
      if (name && body) out.push({name, description: fields.description || firstLine(body), source: 'plugin', plugin: p.name, dir: path.dirname(file), path: file, body, files: [path.basename(file)], aliases: [], command: true, ...(fields['argument-hint'] ? {argumentHint: fields['argument-hint']} : {})});
    }
    for (const dir of p.skills) {
      for (const s of scan(path.dirname(dir), 'plugin').filter((x) => x.dir === dir)) out.push({...s, name: skillName(`${p.name}:${s.name.replace(/^.*:/, '')}`), plugin: p.name, body: pluginVars(s.body, p)});
    }
  }
  return out;
}

/** Claude Code's custom command folders: the project's, then the user's (`~/.claude/commands`). */
export const claudeCommandDirs = (cwd = process.cwd()) => ({
  project: path.join(cwd, '.claude', 'commands'),
  user: path.join(os.homedir(), '.claude', 'commands'),
});

/**
 * Claude Code custom commands: every `*.md` under a commands folder (sub-folders included, as in
 * Claude Code the name is the file name and the folder shows in the description). Frontmatter
 * `description` and `argument-hint` are used; `allowed-tools` / `model` are left to Rein's own
 * permissions and routing.
 */
function scanCommands(root: string, source: 'claude-project' | 'claude-user', sub = ''): Skill[] {
  if (!existsSync(root)) return [];
  const out: Skill[] = [];
  for (const e of readdirSync(path.join(root, sub), {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const rel = sub ? path.join(sub, e.name) : e.name;
    if (e.isDirectory()) {
      out.push(...scanCommands(root, source, rel));
      continue;
    }
    if (!e.name.endsWith('.md')) continue;
    const file = path.join(root, rel);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const {fields, body} = parseSkillFile(text);
    const name = skillName(e.name.replace(/\.md$/, ''));
    if (!name || !body) continue;
    const where = `${source === 'claude-project' ? 'project' : 'user'}${sub ? `:${sub.split(path.sep).join(':')}` : ''}`;
    out.push({
      name,
      description: `${fields.description || firstLine(body)} (${where})`,
      source,
      dir: path.dirname(file),
      path: file,
      body,
      files: [path.basename(file)],
      aliases: [],
      command: true,
      ...(fields['argument-hint'] ? {argumentHint: fields['argument-hint']} : {}),
    });
  }
  return out;
}

const firstLine = (body: string) => (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? body.split('\n')[0] ?? '').trim().slice(0, 100);

/**
 * All skills; on a name clash the built-in wins, then the project's, then the global one, then
 * Claude Code commands (the project's, then the user's).
 */
export function loadSkills(cwd = process.cwd()): Skill[] {
  const dirs = skillDirs(cwd);
  const commands = claudeCommandDirs(cwd);
  const byName = new Map<string, Skill>();
  // Lowest first: installed plugins and Codex skills, then Claude Code commands, then Rein's own.
  for (const s of pluginSkills(cwd)) byName.set(s.name, s);
  for (const root of codexSkillRoots(cwd)) for (const s of scan(root, 'codex')) byName.set(s.name, s);
  for (const s of scanCommands(commands.user, 'claude-user')) byName.set(s.name, s);
  for (const s of scanCommands(commands.project, 'claude-project')) byName.set(s.name, s);
  for (const s of scan(dirs.global, 'global')) byName.set(s.name, s);
  for (const s of scan(dirs.project, 'project')) byName.set(s.name, s);
  // Built-in skills of a pack that's off (migration playbooks…) aren't offered at all.
  for (const s of scan(dirs.builtin, 'builtin')) if (builtinSkillEnabled(s.name)) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The user turn sent when a skill is invoked as `/name args`. Placeholders in SKILL.md are filled
 * in: {{SKILL_DIR}}, {{GLOBAL_SKILLS_DIR}}, {{PROJECT_SKILLS_DIR}}, {{BUILTIN_SKILLS_DIR}}.
 */
export function skillPrompt(skill: Skill, args: string, cwd = process.cwd()): string {
  const dirs = skillDirs(cwd);
  const body = skill.body
    .replaceAll('{{SKILL_DIR}}', skill.dir)
    .replaceAll('{{GLOBAL_SKILLS_DIR}}', dirs.global)
    .replaceAll('{{PROJECT_SKILLS_DIR}}', dirs.project)
    .replaceAll('{{BUILTIN_SKILLS_DIR}}', dirs.builtin);
  if (skill.command) return commandPrompt(skill, body, args);
  const files = skill.files.length > 1 ? `\nFiles in this skill's folder (${skill.dir}): ${skill.files.join(', ')}` : '';
  return `<skill name="${skill.name}" source="${skill.source}" dir="${skill.dir}">\n${body}${files}\n</skill>\n\n${args.trim() || 'Follow the skill above.'}`;
}

/**
 * A Claude Code command, the way Claude Code expands it: `$ARGUMENTS` and `$1`…`$9` are filled in
 * (args are appended when the body uses neither). `!`cmd`` lines, which Claude Code runs before
 * sending, become instructions to run them first, so they go through Rein's approvals like any
 * other command.
 */
function commandPrompt(skill: Skill, body: string, args: string): string {
  const argv = args.trim() ? args.trim().split(/\s+/) : [];
  const usesArgs = /\$ARGUMENTS|\$[1-9]/.test(body);
  let text = body.replaceAll('$ARGUMENTS', args.trim()).replace(/\$([1-9])/g, (_m, n) => argv[Number(n) - 1] ?? '');
  const bang = [...text.matchAll(/!`([^`]+)`/g)].map((m) => m[1]!);
  if (bang.length) text = text.replace(/!`([^`]+)`/g, '`$1`') + `\n\nBefore anything else, run ${bang.length > 1 ? 'these commands' : 'this command'} and use the output: ${bang.map((c) => `\`${c}\``).join(', ')}.`;
  return `<skill name="${skill.name}" source="${skill.source}" file="${skill.path}">\n${text}\n</skill>\n\n${usesArgs ? 'Follow the command above.' : args.trim() || 'Follow the command above.'}`;
}
