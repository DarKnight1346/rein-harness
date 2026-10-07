import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillFile, skillName } from '../skills/index.js';
import { reinConfigDir } from '../store/paths.js';
import { loadPlugins, pluginVars } from '../plugins/index.js';
export const agentDefinitionDirs = (cwd = process.cwd()) => [
    path.join(os.homedir(), '.claude', 'agents'),
    path.join(reinConfigDir(), 'agents'),
    path.join(cwd, '.claude', 'agents'),
    path.join(cwd, '.rein', 'agents'),
];
/** Claude Code tool names → Rein's. Rein names and `mcp__…` names pass through. */
const CLAUDE_TOOLS = {
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
export function mapTools(list) {
    const out = new Set();
    for (const raw of list.split(',').map((t) => t.trim()).filter(Boolean)) {
        if (raw.startsWith('mcp__'))
            out.add(raw);
        else
            for (const t of CLAUDE_TOOLS[raw.toLowerCase()] ?? [raw.toLowerCase()])
                out.add(t);
    }
    return [...out];
}
export function loadAgentDefinitions(cwd = process.cwd()) {
    const byName = new Map();
    // Lowest first: installed plugins' agents (as `<plugin>:<name>`), then the folders above.
    const sources = [
        ...loadPlugins(cwd).map((p) => ({ files: p.agents, prefix: p.name, vars: (t) => pluginVars(t, p) })),
        ...agentDefinitionDirs(cwd).filter((d) => existsSync(d)).map((d) => ({ files: readdirSync(d).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(d, f)) })),
    ];
    for (const src of sources) {
        for (const file of src.files) {
            const f = path.basename(file);
            let text;
            try {
                text = readFileSync(file, 'utf8');
            }
            catch {
                continue;
            }
            const { fields, body } = parseSkillFile(src.vars ? src.vars(text) : text);
            const base = fields.name || f.replace(/\.md$/, '');
            const name = skillName(src.prefix ? `${src.prefix}:${base}` : base);
            if (!name || !body)
                continue;
            byName.set(name, {
                name,
                description: fields.description || body.split('\n')[0].slice(0, 120),
                ...(fields.tools ? { tools: mapTools(fields.tools) } : {}),
                ...(fields.model ? { model: fields.model.trim() } : {}),
                prompt: body,
                file,
            });
        }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** Claude Code's model aliases → a Rein model ref ('inherit' and unknown aliases → undefined). */
export function definitionModel(model) {
    if (!model || model === 'inherit')
        return undefined;
    if (model.includes(':'))
        return model;
    return ['sonnet', 'opus', 'haiku'].includes(model.toLowerCase()) ? `claude:${model.toLowerCase()}` : undefined;
}
