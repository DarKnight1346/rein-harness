import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reinHome } from '../store/paths.js';
const home = () => process.env.REIN_PLUGINS_HOME ?? os.homedir();
const readJson = (file) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
};
const isDir = (p) => {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
};
/** A manifest path inside the plugin (never outside it: no `..` escapes). */
const inside = (root, rel) => {
    if (typeof rel !== 'string')
        return undefined;
    const p = path.resolve(root, rel);
    return p === root || p.startsWith(root + path.sep) ? p : undefined;
};
const mdFiles = (dir, depth = 0) => !isDir(dir) || depth > 3
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? mdFiles(path.join(dir, e.name), depth + 1) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));
const skillDirsIn = (dir) => (isDir(dir) ? readdirSync(dir).map((d) => path.join(dir, d)).filter((d) => existsSync(path.join(d, 'SKILL.md'))) : []);
const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
/** `${CLAUDE_PLUGIN_ROOT}` / `${PLUGIN_ROOT}` (and the …_DATA folders) in a plugin's files. */
export function pluginVars(text, p) {
    const data = path.join(reinHome(), 'plugin-data', p.name);
    return text.replace(/\$\{(CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, p.root).replace(/\$\{(CLAUDE_PLUGIN_DATA|PLUGIN_DATA)\}/g, data);
}
const varsDeep = (v, p) => typeof v === 'string' ? pluginVars(v, p) : Array.isArray(v) ? v.map((x) => varsDeep(x, p)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, varsDeep(x, p)])) : v;
function readPlugin(root, id, from, version) {
    const manifestFile = ['.claude-plugin', '.codex-plugin', '.cursor-plugin'].map((d) => path.join(root, d, 'plugin.json')).find(existsSync);
    const m = (manifestFile ? readJson(manifestFile) : undefined) ?? {};
    const name = typeof m.name === 'string' && m.name ? m.name : id.split('@')[0];
    const fromManifest = (field) => list(field).map((r) => inside(root, r)).filter((p) => !!p);
    // `commands` / `agents` in the manifest replace the default folder; `skills` adds to it.
    const commands = (m.commands !== undefined ? fromManifest(m.commands) : [path.join(root, 'commands')]).flatMap((p) => (p.endsWith('.md') ? [p] : mdFiles(p)));
    const agents = (m.agents !== undefined ? fromManifest(m.agents) : [path.join(root, 'agents')]).flatMap((p) => (p.endsWith('.md') ? [p] : mdFiles(p)));
    const skills = [...skillDirsIn(path.join(root, 'skills')), ...fromManifest(m.skills).flatMap((p) => (existsSync(path.join(p, 'SKILL.md')) ? [p] : skillDirsIn(p)))];
    const hooksFile = typeof m.hooks === 'string' ? inside(root, m.hooks) : path.join(root, 'hooks', 'hooks.json');
    const hooksObj = (m.hooks && typeof m.hooks === 'object' ? m.hooks : hooksFile ? readJson(hooksFile) : undefined);
    const mcpFile = typeof m.mcpServers === 'string' ? inside(root, m.mcpServers) : path.join(root, '.mcp.json');
    const mcpRaw = (m.mcpServers && typeof m.mcpServers === 'object' ? m.mcpServers : mcpFile ? readJson(mcpFile) : undefined);
    const plugin = { id, name, from, root, version: m.version ?? version, description: m.description ?? m.interface?.shortDescription, commands, skills: [...new Set(skills)], agents };
    const hooks = hooksObj?.hooks ?? hooksObj;
    if (hooks && typeof hooks === 'object' && !Array.isArray(hooks))
        plugin.hooks = varsDeep(hooks, plugin);
    // Claude's .mcp.json is a flat {name: config}; Codex wraps it in {mcpServers: …}.
    const servers = mcpRaw?.mcpServers ?? mcpRaw;
    if (servers && typeof servers === 'object' && !Array.isArray(servers) && Object.keys(servers).length)
        plugin.mcpServers = varsDeep(servers, plugin);
    return plugin;
}
/** enabledPlugins from Claude Code's settings (user < project < local; later wins). */
function claudeEnabled(cwd) {
    const out = {};
    for (const file of [path.join(home(), '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
        const e = readJson(file)?.enabledPlugins;
        if (e && typeof e === 'object')
            for (const [k, v] of Object.entries(e))
                out[k] = v !== false;
    }
    return out;
}
function claudePlugins(cwd) {
    const installed = readJson(path.join(home(), '.claude', 'plugins', 'installed_plugins.json'))?.plugins;
    if (!installed || typeof installed !== 'object')
        return [];
    const enabled = claudeEnabled(cwd);
    const out = [];
    for (const [id, raw] of Object.entries(installed)) {
        if (id.endsWith('@builtin'))
            continue;
        // One record, or one per scope (user / project / local); project-scoped ones only for that project.
        const records = list(raw).filter((r) => r && typeof r.installPath === 'string' && (!r.projectPath || path.resolve(r.projectPath) === path.resolve(cwd)));
        const rec = records.at(-1);
        if (!rec || !isDir(rec.installPath))
            continue;
        const plugin = readPlugin(path.resolve(rec.installPath), id, 'claude', rec.version);
        if (!plugin)
            continue;
        const manifest = readJson(path.join(plugin.root, '.claude-plugin', 'plugin.json')) ?? {};
        if (enabled[id] ?? manifest.defaultEnabled !== false)
            out.push(plugin);
    }
    return out;
}
/** Codex: plugins switched off in config.toml (`[plugins."name@marketplace"]` … `enabled = false`). */
function codexDisabled() {
    const off = new Set();
    let text = '';
    try {
        text = readFileSync(path.join(process.env.CODEX_HOME ?? path.join(home(), '.codex'), 'config.toml'), 'utf8');
    }
    catch {
        return off;
    }
    let current;
    for (const line of text.split('\n')) {
        const section = /^\s*\[plugins\.(?:"([^"]+)"|([\w.@-]+))\]\s*$/.exec(line);
        if (section)
            current = section[1] ?? section[2];
        else if (/^\s*\[/.test(line))
            current = undefined;
        else if (current && /^\s*enabled\s*=\s*false\b/.test(line))
            off.add(current);
    }
    return off;
}
const versionKey = (v) => v.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? x.padStart(8, '0') : x)).join('.');
function codexPlugins() {
    const cache = path.join(process.env.CODEX_HOME ?? path.join(home(), '.codex'), 'plugins', 'cache');
    if (!isDir(cache))
        return [];
    const off = codexDisabled();
    const out = [];
    for (const market of readdirSync(cache).filter((d) => !d.startsWith('.') && isDir(path.join(cache, d)))) {
        for (const name of readdirSync(path.join(cache, market)).filter((d) => !d.startsWith('.') && isDir(path.join(cache, market, d)))) {
            const id = `${name}@${market}`;
            if (off.has(id))
                continue;
            const versions = readdirSync(path.join(cache, market, name)).filter((v) => !v.startsWith('.') && isDir(path.join(cache, market, name, v)));
            const newest = versions.sort((a, b) => versionKey(a).localeCompare(versionKey(b))).at(-1);
            if (!newest)
                continue;
            const plugin = readPlugin(path.join(cache, market, name, newest), id, 'codex', newest);
            if (plugin)
                out.push(plugin);
        }
    }
    return out;
}
let cached;
/** Every enabled plugin (Claude Code's first on a name clash). Cached for a few seconds. */
export function loadPlugins(cwd = process.cwd()) {
    const key = `${cwd}|${home()}`;
    if (cached && cached.key === key && Date.now() - cached.at < 5000)
        return cached.plugins;
    const seen = new Set();
    const plugins = [...claudePlugins(cwd), ...codexPlugins()].filter((p) => !seen.has(p.name) && (seen.add(p.name), true));
    cached = { key, at: Date.now(), plugins };
    return plugins;
}
/** Codex's skill folders (`$CODEX_HOME/skills`, `~/.agents/skills`, `<project>/.agents/skills`), minus Codex's own `.system` ones. */
export function codexSkillRoots(cwd = process.cwd()) {
    return [path.join(process.env.CODEX_HOME ?? path.join(home(), '.codex'), 'skills'), path.join(home(), '.agents', 'skills'), path.join(cwd, '.agents', 'skills')].filter(isDir);
}
