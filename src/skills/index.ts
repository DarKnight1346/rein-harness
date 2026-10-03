import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reinHome} from '../store/paths.js';

export type SkillSource = 'builtin' | 'project' | 'global';

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
};

/**
 * Optional `<skill>/config.json`: `{"name"?, "description"?, "main"?: "PROMPT.md", "aliases"?: ["sc"]}`.
 * Each field falls back: config.json → the main file's frontmatter → defaults (main `SKILL.md`, the
 * folder name, the first line of the instructions). A missing `main` file falls back to SKILL.md.
 */
type SkillConfig = {name?: string; description?: string; main?: string; aliases?: string[]; planMode?: boolean};

/** Rein's own skills ship in `<install>/skills` (works from src/ via tsx and from dist/). */
export const builtinSkillsDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

export const skillDirs = (cwd = process.cwd()) => ({
  builtin: builtinSkillsDir(),
  global: path.join(reinHome(), 'skills'),
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
    });
  }
  return out;
}

const firstLine = (body: string) => (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? body.split('\n')[0] ?? '').trim().slice(0, 100);

/** All skills; on a name clash the built-in wins, then the project's, then the global one. */
export function loadSkills(cwd = process.cwd()): Skill[] {
  const dirs = skillDirs(cwd);
  const byName = new Map<string, Skill>();
  for (const s of scan(dirs.global, 'global')) byName.set(s.name, s);
  for (const s of scan(dirs.project, 'project')) byName.set(s.name, s);
  for (const s of scan(dirs.builtin, 'builtin')) byName.set(s.name, s);
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
  const files = skill.files.length > 1 ? `\nFiles in this skill's folder (${skill.dir}): ${skill.files.join(', ')}` : '';
  return `<skill name="${skill.name}" source="${skill.source}" dir="${skill.dir}">\n${body}${files}\n</skill>\n\n${args.trim() || 'Follow the skill above.'}`;
}
