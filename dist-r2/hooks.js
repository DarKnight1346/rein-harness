import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { trustedHooksHash, trustHooks } from './store/trust.js';
import { loadPlugins } from './plugins/index.js';
import { settingsFiles } from './tools/permissions.js';
import { isWindows, shellFor } from './util/platform.js';
/** Claude Code's names for Rein's tools, so matchers written for Claude Code still apply. */
const CLAUDE_NAMES = {
    shell: ['Bash'],
    edit: ['Edit', 'MultiEdit'],
    write: ['Write'],
    read: ['Read'],
    search: ['Grep'],
    list: ['Glob', 'LS'],
    web_fetch: ['WebFetch'],
    web_search: ['WebSearch'],
    agent: ['Task'],
    todo_write: ['TodoWrite'],
};
function hooksIn(file) {
    try {
        const hooks = JSON.parse(readFileSync(file, 'utf8'))?.hooks;
        return hooks && typeof hooks === 'object' && Object.keys(hooks).length ? hooks : undefined;
    }
    catch {
        return undefined;
    }
}
/** The project's own settings files (a cloned repo can ship these); the first two are the user's. */
const projectFiles = (root) => settingsFiles(root).slice(2);
/** Hooks defined by the project's settings files, and whether the user trusted them as they are now. */
export function projectHooks(root) {
    const found = projectFiles(root).flatMap((file) => {
        const hooks = hooksIn(file);
        return hooks ? [{ file, hooks }] : [];
    });
    if (!found.length)
        return undefined;
    const hash = createHash('sha256').update(JSON.stringify(found.map((f) => [path.relative(root, f.file), f.hooks]))).digest('hex');
    const commands = found.flatMap(({ file, hooks }) => Object.entries(hooks).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []).filter((h) => typeof h?.command === 'string').map((h) => ({ event, command: h.command, file: path.relative(root, file) })))));
    return { hash, trusted: trustedHooksHash(root) === hash, commands };
}
/** Trust the project's hooks as they are now (they run from then on, until they change). */
export function trustProjectHooks(root) {
    const p = projectHooks(root);
    if (p)
        trustHooks(root, p.hash);
}
/** Called when untrusted project hooks are skipped (once per version of them), so the UI can ask. */
let onUntrusted;
let reported;
export function onUntrustedHooks(fn) {
    onUntrusted = fn;
}
function readHooks(root, projectOnly = false) {
    const out = {};
    const project = projectHooks(root);
    if (project && !project.trusted && reported !== project.hash) {
        reported = project.hash;
        onUntrusted?.(project);
    }
    const files = settingsFiles(root);
    const add = (hooks) => {
        for (const [event, groups] of Object.entries(hooks ?? {})) {
            if (!Array.isArray(groups))
                continue;
            (out[event] ??= []).push(...groups.filter((g) => Array.isArray(g?.hooks)));
        }
    };
    for (const file of project?.trusted ? files.slice(projectOnly ? 2 : 0) : projectOnly ? [] : files.slice(0, 2))
        add(hooksIn(file));
    // Installed plugins' hooks run like the user's own (installing the plugin was the consent).
    if (!projectOnly)
        for (const p of loadPlugins(root))
            add(p.hooks);
    return out;
}
/** A group's matcher (a regex over tool names; empty or "*" = all) against Rein's and Claude Code's names. */
function matches(matcher, tool) {
    if (!tool || !matcher || matcher === '*')
        return true;
    const names = [tool, ...(CLAUDE_NAMES[tool] ?? [])];
    try {
        const re = new RegExp(`^(?:${matcher})$`);
        return names.some((n) => re.test(n));
    }
    catch {
        return names.includes(matcher);
    }
}
function runCommand(cmd, input, root) {
    return new Promise((resolve) => {
        // Hooks are usually bash: Git Bash on Windows when installed (as in Claude Code), else PowerShell.
        const shell = isWindows ? shellFor(cmd.command) : { file: '/bin/sh', args: ['-c', cmd.command] };
        const child = spawn(shell.file, shell.args, {
            windowsHide: true, cwd: root, env: { ...process.env, REIN_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, (cmd.timeout ?? 60) * 1000);
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ code: null, stdout, stderr: err.message, timedOut });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
        });
        child.stdin.on('error', () => { });
        child.stdin.end(JSON.stringify(input));
    });
}
/** Run every hook for `event` (matching `tool`), in order; the first block wins. */
export async function runHooks(event, root, payload, opts = {}) {
    const groups = (readHooks(root, opts.projectOnly)[event] ?? []).filter((g) => matches(g.matcher, payload.tool));
    const outcome = { errors: [] };
    const context = [];
    const input = { hook_event_name: event, cwd: root, ...(payload.tool ? { tool_name: payload.tool } : {}), ...payload };
    for (const cmd of groups.flatMap((g) => g.hooks).filter((h) => h?.type === 'command' && typeof h.command === 'string')) {
        const r = await runCommand(cmd, input, root);
        if (r.timedOut) {
            outcome.errors.push(`${event} hook timed out: ${cmd.command}`);
            continue;
        }
        if (r.code === 2) {
            outcome.block = r.stderr || `blocked by a ${event} hook`;
            break;
        }
        if (r.code !== 0) {
            outcome.errors.push(`${event} hook failed (exit ${r.code}): ${r.stderr || cmd.command}`);
            continue;
        }
        let json;
        try {
            json = r.stdout.startsWith('{') ? JSON.parse(r.stdout) : undefined;
        }
        catch { }
        const spec = json?.hookSpecificOutput ?? {};
        const reason = spec.permissionDecisionReason ?? json?.reason ?? '';
        if (json?.decision === 'block' || spec.permissionDecision === 'deny') {
            outcome.block = reason || `blocked by a ${event} hook`;
            break;
        }
        if (spec.permissionDecision === 'allow' || json?.decision === 'approve')
            outcome.allow = true;
        if (spec.permissionDecision === 'ask')
            outcome.ask = true;
        if (typeof spec.additionalContext === 'string')
            context.push(spec.additionalContext);
        else if (!json && r.stdout && (event === 'UserPromptSubmit' || event === 'SessionStart'))
            context.push(r.stdout);
    }
    if (context.length)
        outcome.context = context.join('\n');
    return outcome;
}
/** Whether any hook is configured for an event (skips the work when none are). */
export function hasHooks(event, root, opts = {}) {
    return (readHooks(root, opts.projectOnly)[event] ?? []).length > 0;
}
