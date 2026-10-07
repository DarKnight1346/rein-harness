import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reinConfigDir } from '../store/paths.js';
import { updateJsonFileSync } from '../store/json.js';
const ALIASES = { bash: 'shell', edit: 'edit', write: 'edit', multiedit: 'edit', delete: 'edit', read: 'read', webfetch: 'web_fetch', websearch: 'web_search' };
function parseRule(rule) {
    const m = /^\s*([\w.-]+)\s*(?:\((.*)\))?\s*$/.exec(rule);
    if (!m)
        return undefined;
    const name = m[1];
    const tool = name.startsWith('mcp__') ? name : (ALIASES[name.toLowerCase()] ?? name.toLowerCase());
    return { tool, spec: m[2]?.trim() || undefined };
}
/** The rule group a tool belongs to (write/edit/delete share `edit`, like Claude Code's Edit). */
export function ruleTool(name) {
    if (name === 'write' || name === 'delete' || name === 'edit' || name === 'image_generate')
        return 'edit';
    return name;
}
function readRules(file) {
    try {
        const p = JSON.parse(readFileSync(file, 'utf8'))?.permissions ?? {};
        return { allow: Array.isArray(p.allow) ? p.allow.map(String) : [], deny: Array.isArray(p.deny) ? p.deny.map(String) : [] };
    }
    catch {
        return { allow: [], deny: [] };
    }
}
/** Settings files, global first. */
export function settingsFiles(root) {
    return [
        process.env.REIN_CLAUDE_SETTINGS ?? path.join(os.homedir(), '.claude', 'settings.json'),
        path.join(reinConfigDir(), 'settings.json'),
        path.join(root, '.claude', 'settings.json'),
        path.join(root, '.claude', 'settings.local.json'),
        path.join(root, '.rein', 'settings.json'),
        path.join(root, '.rein', 'settings.local.json'),
    ];
}
export function loadRules(root) {
    const all = settingsFiles(root).map(readRules);
    return { allow: all.flatMap((r) => r.allow), deny: all.flatMap((r) => r.deny) };
}
/** Glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
function globRe(glob) {
    // Rules use forward slashes; Windows paths are normalized to match (see check()).
    const g = glob.replace(/^~(?=\/|$)/, os.homedir().replace(/\\/g, '/')).replace(/\\/g, '/');
    let re = '';
    for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*' && g[i + 1] === '*') {
            re += '.*';
            i++;
            if (g[i + 1] === '/')
                i++;
        }
        else if (c === '*')
            re += '[^/]*';
        else if (c === '?')
            re += '[^/]';
        else
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${re}$`);
}
/**
 * Split a shell command into simple commands (&&, ||, ;, |, newlines), outside quotes. Returns
 * undefined when it has command substitution or redirection into a subshell we can't vet.
 */
export function splitCommand(cmd) {
    if (/\$\(|`|<\(|>\(/.test(cmd))
        return undefined;
    const parts = [];
    let cur = '';
    let quote = '';
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (quote) {
            if (c === quote)
                quote = '';
            cur += c;
        }
        else if (c === '"' || c === "'") {
            quote = c;
            cur += c;
        }
        else if (c === '\\' && i + 1 < cmd.length) {
            cur += c + cmd[++i];
        }
        else if (c === ';' || c === '\n' || c === '|' || c === '&') {
            if ((c === '&' || c === '|') && cmd[i + 1] === c)
                i++;
            else if (c === '&') {
                cur += c; // background `&` or redirection like 2>&1: keep it in the command
                continue;
            }
            if (cur.trim())
                parts.push(cur.trim());
            cur = '';
        }
        else
            cur += c;
    }
    if (cur.trim())
        parts.push(cur.trim());
    return parts;
}
function commandMatches(spec, command) {
    const c = command.trim().replace(/\s+/g, ' ');
    if (spec.endsWith(':*')) {
        const prefix = spec.slice(0, -2).trim().replace(/\s+/g, ' ');
        return c === prefix || c.startsWith(prefix + ' ');
    }
    return c === spec.trim().replace(/\s+/g, ' ');
}
/** Does one rule cover this call? (shell: one simple command; paths: every path, in any form.) */
function ruleCovers(rule, s, forms, part) {
    const tool = ruleTool(s.tool);
    if (rule.tool.startsWith('mcp__'))
        return s.tool === rule.tool || s.tool.startsWith(rule.tool + '__');
    if (rule.tool !== tool)
        return false;
    if (!rule.spec || rule.spec === '*')
        return true;
    if (tool === 'shell')
        return part !== undefined && commandMatches(rule.spec, part);
    if (tool === 'web_fetch') {
        if (!rule.spec.startsWith('domain:') || !s.url)
            return false;
        try {
            const host = new URL(s.url).hostname;
            const d = rule.spec.slice(7).toLowerCase();
            return host === d || host.endsWith('.' + d);
        }
        catch {
            return false;
        }
    }
    if (!s.paths?.length)
        return false;
    const re = globRe(rule.spec);
    return s.paths.every((p) => forms(p).some((f) => re.test(f.replace(/\\/g, '/'))));
}
/**
 * Verdict for a call: 'deny' if any deny rule covers it; 'allow' if allow rules cover it — for
 * shell, every simple command must be allowed (and none denied), so `npm test && rm -rf /` isn't
 * waved through by `shell(npm test:*)`; otherwise undefined (normal approval). `forms` gives the
 * ways a path may be written in a rule (project-relative and absolute).
 */
export function check(rules, s, forms) {
    const allow = rules.allow.map(parseRule).filter((r) => !!r);
    const deny = rules.deny.map(parseRule).filter((r) => !!r);
    if (ruleTool(s.tool) === 'shell') {
        if (deny.some((r) => r.tool === 'shell' && !r.spec))
            return 'deny';
        const parts = s.command !== undefined ? splitCommand(s.command) : undefined;
        if (parts?.some((p) => deny.some((r) => ruleCovers(r, s, forms, p))))
            return 'deny';
        if (!parts?.length)
            return undefined; // substitutions etc.: always ask
        return parts.every((p) => allow.some((r) => ruleCovers(r, s, forms, p))) ? 'allow' : undefined;
    }
    // Deny if a rule covers any one path; allow only if every path is covered by some rule.
    const each = (p) => ({ ...s, paths: [p] });
    if (s.paths?.length ? s.paths.some((p) => deny.some((r) => ruleCovers(r, each(p), forms))) : deny.some((r) => ruleCovers(r, s, forms)))
        return 'deny';
    if (s.paths?.length)
        return s.paths.every((p) => allow.some((r) => ruleCovers(r, each(p), forms))) ? 'allow' : undefined;
    return allow.some((r) => ruleCovers(r, s, forms)) ? 'allow' : undefined;
}
/** Programs whose first argument is a subcommand worth keeping in a suggested rule. */
const SUBCOMMAND_TOOLS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'deno', 'git', 'gh', 'cargo', 'go', 'docker', 'kubectl', 'helm', 'make', 'pip', 'pip3', 'uv', 'poetry', 'brew', 'apt', 'dotnet', 'mvn', 'gradle', 'swift', 'terraform', 'rails', 'bundle', 'composer', 'mix', 'flutter', 'dart']);
/** The rule offered as "always allow …" in the approval prompt. */
export function suggestRule(s, rel) {
    const tool = ruleTool(s.tool);
    if (tool === 'shell') {
        const parts = s.command !== undefined ? splitCommand(s.command) : undefined;
        if (!parts || parts.length !== 1)
            return undefined; // compound commands: approve each kind separately
        const words = parts[0].split(/\s+/);
        // Tools with subcommands get two words (npm test, git status, cargo build); others one.
        const sub = words[1] && SUBCOMMAND_TOOLS.has(path.basename(words[0])) && /^[a-z][\w:-]*$/.test(words[1]) ? `${words[0]} ${words[1]}` : words[0];
        return `shell(${sub}:*)`;
    }
    if (tool === 'web_fetch' && s.url) {
        try {
            return `web_fetch(domain:${new URL(s.url).hostname})`;
        }
        catch {
            return undefined;
        }
    }
    if (s.paths?.length === 1) {
        const r = rel(s.paths[0]).replace(/\\/g, '/');
        const dir = path.posix.dirname(r);
        return `${tool}(${dir === '.' ? '**' : `${dir}/**`})`;
    }
    return tool === 'edit' || tool === 'read' ? undefined : tool;
}
/** Save an allow rule to the project's .rein/settings.json (created if needed). */
export function addProjectRule(root, rule, list = 'allow') {
    const file = path.join(root, '.rein', 'settings.json');
    updateJsonFileSync(file, (data) => {
        data.permissions ??= {};
        data.permissions[list] = [...new Set([...(data.permissions[list] ?? []), rule])];
    });
    return file;
}
