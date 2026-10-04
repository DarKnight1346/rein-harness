import {ToolError} from '../tools/fs.js';
import type {ToolDef} from '../tools/registry.js';
import {loadSkills, skillPrompt, type Skill} from './index.js';

const SOURCE: Record<Skill['source'], string> = {builtin: 'built-in', project: 'project', global: 'global', 'claude-project': 'Claude Code command, project', 'claude-user': 'Claude Code command'};

/** A skill by name or one of its aliases. */
function find(skills: Skill[], name: string): Skill | undefined {
  const n = name.replace(/^\//, '').trim().toLowerCase();
  return skills.find((s) => s.name === n) ?? skills.find((s) => s.aliases.includes(n));
}

/**
 * `skill` (like Claude Code's Skill tool): the model sees every installed skill — built-in, the
 * project's (.rein/skills) and global (~/.rein/skills) — in this tool's description, and loads one
 * when the task matches. The result is the skill's instructions (and its folder) to follow.
 */
export function skillTool(cwd: () => string, onPlanMode: () => void = () => {}): ToolDef {
  return {
    name: 'skill',
    label: 'Skill',
    description: 'Load a skill.',
    enabled: () => loadSkills(cwd()).length > 0,
    describe: () => {
      const skills = loadSkills(cwd());
      return [
        'Load a skill: packaged instructions (and sometimes scripts/files) for a specific kind of task. When the user\'s request matches a skill below, call this first and follow what it returns. The user can also run one as /name.',
        'Available skills:',
        ...skills.map((s) => `- ${s.name}${s.aliases.length ? ` (alias: ${s.aliases.join(', ')})` : ''} [${SOURCE[s.source]}]: ${s.description}`),
      ].join('\n');
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: {type: 'string', description: 'Skill name (or alias) from the list'},
        args: {type: 'string', description: 'What to do with it — the user\'s request or details (optional)'},
      },
      required: ['name'],
    },
    mutating: false,
    summarize: (a) => String(a?.name ?? ''),
    async run(_ctx, args) {
      const skills = loadSkills(cwd());
      const skill = find(skills, String(args?.name ?? ''));
      if (!skill) throw new ToolError(`no skill "${args?.name}"; available: ${skills.map((s) => s.name).join(', ') || 'none'}`);
      if (skill.planMode) onPlanMode();
      return {ok: true, text: `Skill "${skill.name}" loaded — follow these instructions:\n\n${skillPrompt(skill, typeof args.args === 'string' ? args.args : '', cwd())}`};
    },
  };
}
