import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reinConfigDir } from '../store/paths.js';
import { updateJsonFileSync } from '../store/json.js';
import { loadPlugins } from '../plugins/index.js';
const expand = (s) => s.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name, def) => process.env[name] ?? def ?? '');
function expandDeep(v) {
    if (typeof v === 'string')
        return expand(v);
    if (Array.isArray(v))
        return v.map(expandDeep);
    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x)]));
    return v;
}
function servers(file, pick = (j) => j?.mcpServers) {
    try {
        const s = pick(JSON.parse(readFileSync(file, 'utf8')));
        return s && typeof s === 'object' ? s : {};
    }
    catch {
        return {};
    }
}
const localSettings = (root) => path.join(root, '.rein', 'settings.local.json');
/** Project servers the user approved (Claude Code keeps the same list in its local settings). */
function approvedProjectServers(root) {
    const names = new Set();
    for (const file of [localSettings(root), path.join(root, '.claude', 'settings.local.json')]) {
        try {
            for (const n of JSON.parse(readFileSync(file, 'utf8'))?.enabledMcpjsonServers ?? [])
                names.add(String(n));
        }
        catch { }
    }
    return names;
}
export function approveProjectServer(root, name) {
    updateJsonFileSync(localSettings(root), (data) => {
        data.enabledMcpjsonServers = [...new Set([...(data.enabledMcpjsonServers ?? []), name])];
    });
}
/** Every configured server; later sources don't override earlier names (project → rein → claude). */
export function loadServers(root) {
    const approved = approvedProjectServers(root);
    const claudeJson = process.env.REIN_CLAUDE_JSON ?? path.join(os.homedir(), '.claude.json');
    const sources = [
        ['project', servers(path.join(root, '.mcp.json'))],
        ['rein', servers(path.join(reinConfigDir(), 'mcp.json'))],
        ['claude', { ...servers(claudeJson), ...servers(claudeJson, (j) => j?.projects?.[root]?.mcpServers) }],
        // Installed plugins' servers (installing the plugin was the consent), as `<plugin>-<name>`.
        ['plugin', Object.fromEntries(loadPlugins(root).flatMap((p) => Object.entries(p.mcpServers ?? {}).map(([n, c]) => [`${p.name}-${n}`, c])))],
    ];
    const out = [];
    for (const [source, map] of sources) {
        for (const [name, config] of Object.entries(map)) {
            if (out.some((s) => s.name === name) || !config || typeof config !== 'object')
                continue;
            out.push({ name, config: expandDeep(config), source, approved: source !== 'project' || approved.has(name) });
        }
    }
    return out;
}
/** Where a scope's servers live: the project's shared .mcp.json, or the user's ~/.rein/mcp.json. */
export const scopeFile = (root, scope) => (scope === 'project' ? path.join(root, '.mcp.json') : path.join(reinConfigDir(), 'mcp.json'));
export const validServerName = (name) => /^[A-Za-z0-9_-]{1,40}$/.test(name);
/**
 * Add (or replace) a server in a scope's file. A project server added through the agent's tool
 * is approved at the same time — the user approved the call that showed its command.
 */
export function addServer(root, scope, name, config) {
    const file = scopeFile(root, scope);
    updateJsonFileSync(file, (data) => {
        data.mcpServers = { ...(data.mcpServers ?? {}), [name]: config };
    });
    if (scope === 'project')
        approveProjectServer(root, name);
    return file;
}
/** Remove a server from whichever Rein-managed file defines it; undefined if none does. */
export function removeServer(root, name) {
    for (const scope of ['project', 'user']) {
        const file = scopeFile(root, scope);
        let found = false;
        try {
            found = !!JSON.parse(readFileSync(file, 'utf8'))?.mcpServers?.[name];
        }
        catch { }
        if (!found)
            continue;
        updateJsonFileSync(file, (data) => {
            delete data.mcpServers[name];
        });
        return file;
    }
    return undefined;
}
