import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {settingsFiles} from './tools/permissions.js';

/**
 * Hooks, in Claude Code's format and semantics, so existing `.claude/settings.json` hooks work:
 *   "hooks": {"PreToolUse": [{"matcher": "Bash|shell", "hooks": [{"type": "command", "command": "…", "timeout": 60}]}]}
 * Read from every settings file (see permissions.ts). The command gets the event as JSON on stdin
 * and runs in the project root with REIN_PROJECT_DIR / CLAUDE_PROJECT_DIR set. Exit code 2 blocks
 * (stderr goes to the model, or to the user for UserPromptSubmit); other non-zero codes are
 * reported but don't block. JSON on stdout can also decide: {"decision": "block", "reason": …},
 * PreToolUse {"hookSpecificOutput": {"permissionDecision": "allow" | "deny" | "ask", …}}, and
 * {"hookSpecificOutput": {"additionalContext": …}} / plain stdout for context events.
 */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'SessionStart';

type HookCommand = {type: 'command'; command: string; timeout?: number};
type HookGroup = {matcher?: string; hooks: HookCommand[]};

export type HookOutcome = {
  /** Block the action (exit 2, or decision "block" / permissionDecision "deny"). */
  block?: string;
  /** PreToolUse: approve without asking (permissionDecision "allow" / decision "approve"). */
  allow?: boolean;
  /** PreToolUse: force the normal approval prompt. */
  ask?: boolean;
  /** Text to add to the model's context (stdout of context events, additionalContext). */
  context?: string;
  /** Non-blocking problems (other exit codes, timeouts) to show the user. */
  errors: string[];
};

/** Claude Code's names for Rein's tools, so matchers written for Claude Code still apply. */
const CLAUDE_NAMES: Record<string, string[]> = {
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

function readHooks(root: string): Partial<Record<HookEvent, HookGroup[]>> {
  const out: Partial<Record<HookEvent, HookGroup[]>> = {};
  for (const file of settingsFiles(root)) {
    let hooks: any;
    try {
      hooks = JSON.parse(readFileSync(file, 'utf8'))?.hooks;
    } catch {
      continue;
    }
    if (!hooks || typeof hooks !== 'object') continue;
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      (out[event as HookEvent] ??= []).push(...(groups as HookGroup[]).filter((g) => Array.isArray(g?.hooks)));
    }
  }
  return out;
}

/** A group's matcher (a regex over tool names; empty or "*" = all) against Rein's and Claude Code's names. */
function matches(matcher: string | undefined, tool: string | undefined): boolean {
  if (!tool || !matcher || matcher === '*') return true;
  const names = [tool, ...(CLAUDE_NAMES[tool] ?? [])];
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return names.some((n) => re.test(n));
  } catch {
    return names.includes(matcher);
  }
}

function runCommand(cmd: HookCommand, input: object, root: string): Promise<{code: number | null; stdout: string; stderr: string; timedOut: boolean}> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? {file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', cmd.command]} : {file: '/bin/sh', args: ['-c', cmd.command]};
    const child = spawn(shell.file, shell.args, {cwd: root, env: {...process.env, REIN_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root}, stdio: ['pipe', 'pipe', 'pipe']});
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
      resolve({code: null, stdout, stderr: err.message, timedOut});
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut});
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

/** Run every hook for `event` (matching `tool`), in order; the first block wins. */
export async function runHooks(event: HookEvent, root: string, payload: {tool?: string} & Record<string, unknown>): Promise<HookOutcome> {
  const groups = (readHooks(root)[event] ?? []).filter((g) => matches(g.matcher, payload.tool));
  const outcome: HookOutcome = {errors: []};
  const context: string[] = [];
  const input = {hook_event_name: event, cwd: root, ...(payload.tool ? {tool_name: payload.tool} : {}), ...payload};
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
    let json: any;
    try {
      json = r.stdout.startsWith('{') ? JSON.parse(r.stdout) : undefined;
    } catch {}
    const spec = json?.hookSpecificOutput ?? {};
    const reason = spec.permissionDecisionReason ?? json?.reason ?? '';
    if (json?.decision === 'block' || spec.permissionDecision === 'deny') {
      outcome.block = reason || `blocked by a ${event} hook`;
      break;
    }
    if (spec.permissionDecision === 'allow' || json?.decision === 'approve') outcome.allow = true;
    if (spec.permissionDecision === 'ask') outcome.ask = true;
    if (typeof spec.additionalContext === 'string') context.push(spec.additionalContext);
    else if (!json && r.stdout && (event === 'UserPromptSubmit' || event === 'SessionStart')) context.push(r.stdout);
  }
  if (context.length) outcome.context = context.join('\n');
  return outcome;
}

/** Whether any hook is configured for an event (skips the work when none are). */
export function hasHooks(event: HookEvent, root: string): boolean {
  return (readHooks(root)[event] ?? []).length > 0;
}
