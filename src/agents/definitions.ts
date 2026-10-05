import {existsSync, readdirSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseSkillFile, skillName} from '../skills/index.js';
import {reinConfigDir} from '../store/paths.js';
import {loadPlugins, pluginVars} from '../plugins/index.js';

/**
 * Named subagent definitions, in Claude Code's format (`.claude/agents/<name>.md`): frontmatter
 * `name`, `description`, optional `tools` (comma-separated; omitted = every tool) and `model`
 * (`sonnet` / `opus` / `haiku` / `inherit`, or a Rein ref like `codex:gpt-x`); the body is the
 * subagent's role, added to its system prompt. Rein also reads `.rein/agents`.
 * On a name clash: project `.rein` → project `.claude` → `~/.rein` → `~/.claude`.
 */
export type AgentDefinition = {
  name: string;
  description: string;
  /** Rein tool names the subagent may use; undefined = all of them. */
  tools?: string[];
  model?: string;
  prompt: string;
  file: string;
};

export const agentDefinitionDirs = (cwd = process.cwd()) => [
  path.join(os.homedir(), '.claude', 'agents'),
  path.join(reinConfigDir(), 'agents'),
  path.join(cwd, '.claude', 'agents'),
  path.join(cwd, '.rein', 'agents'),
];

/** Claude Code tool names → Rein's. Rein names and `mcp__…` names pass through. */
const CLAUDE_TOOLS: Record<string, string[]> = {
  read: ['read'],
  write: ['write'],
  edit: ['edit'],
  multiedit: ['edit'],
  bash: ['shell', 'shell_logs', 'shell_kill'],
  grep: ['search'],
  glob: ['list', 'search'],
  ls: ['list'],
  webfetch: ['web_fetch'],
  websearch: ['web_search'],
  notebookedit: ['edit'],
};

export function mapTools(list: string): string[] {
  const out = new Set<string>();
  for (const raw of list.split(',').map((t) => t.trim()).filter(Boolean)) {
    if (raw.startsWith('mcp__')) out.add(raw);
    else for (const t of CLAUDE_TOOLS[raw.toLowerCase()] ?? [raw.toLowerCase()]) out.add(t);
  }
  return [...out];
}

export function loadAgentDefinitions(cwd = process.cwd()): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  // Lowest first: installed plugins' agents (as `<plugin>:<name>`), then the folders above.
  const sources: {files: string[]; prefix?: string; vars?: (t: string) => string}[] = [
    ...loadPlugins(cwd).map((p) => ({files: p.agents, prefix: p.name, vars: (t: string) => pluginVars(t, p)})),
    ...agentDefinitionDirs(cwd).filter((d) => existsSync(d)).map((d) => ({files: readdirSync(d).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(d, f))})),
  ];
  for (const src of sources) {
    for (const file of src.files) {
      const f = path.basename(file);
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const {fields, body} = parseSkillFile(src.vars ? src.vars(text) : text);
      const base = fields.name || f.replace(/\.md$/, '');
      const name = skillName(src.prefix ? `${src.prefix}:${base}` : base);
      if (!name || !body) continue;
      byName.set(name, {
        name,
        description: fields.description || body.split('\n')[0]!.slice(0, 120),
        ...(fields.tools ? {tools: mapTools(fields.tools)} : {}),
        ...(fields.model ? {model: fields.model.trim()} : {}),
        prompt: body,
        file,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Claude Code's model aliases → a Rein model ref ('inherit' and unknown aliases → undefined). */
export function definitionModel(model: string | undefined): string | undefined {
  if (!model || model === 'inherit') return undefined;
  if (model.includes(':')) return model;
  return ['sonnet', 'opus', 'haiku'].includes(model.toLowerCase()) ? `claude:${model.toLowerCase()}` : undefined;
}
