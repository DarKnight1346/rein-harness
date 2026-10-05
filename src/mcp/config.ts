import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reinConfigDir} from '../store/paths.js';
import {updateJsonFileSync} from '../store/json.js';
import {loadPlugins} from '../plugins/index.js';

/**
 * MCP server configs in Claude Code's format (`{"mcpServers": {name: {command, args, env} |
 * {type: "http" | "sse", url, headers}}}`), from:
 * - <project>/.mcp.json — the project's shared servers; each needs the user's approval once (a
 *   repo shouldn't be able to make Rein launch commands), remembered in .rein/settings.local.json
 * - ~/.rein/mcp.json — the user's own servers
 * - ~/.claude.json — servers added with `claude mcp add` (user and this-project scopes), trusted
 * `${VAR}` and `${VAR:-default}` are expanded in strings, as in Claude Code.
 */
export type StdioServer = {type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>};
export type RemoteServer = {type: 'http' | 'sse'; url: string; headers?: Record<string, string>};
export type ServerConfig = StdioServer | RemoteServer;
export type ServerSource = 'project' | 'rein' | 'claude' | 'plugin';
export type ServerEntry = {name: string; config: ServerConfig; source: ServerSource; approved: boolean};

const expand = (s: string) => s.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => process.env[name] ?? def ?? '');

function expandDeep<T>(v: T): T {
  if (typeof v === 'string') return expand(v) as T;
  if (Array.isArray(v)) return v.map(expandDeep) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandDeep(x)])) as T;
  return v;
}

function servers(file: string, pick: (json: any) => unknown = (j) => j?.mcpServers): Record<string, ServerConfig> {
  try {
    const s = pick(JSON.parse(readFileSync(file, 'utf8')));
    return s && typeof s === 'object' ? (s as Record<string, ServerConfig>) : {};
  } catch {
    return {};
  }
}

const localSettings = (root: string) => path.join(root, '.rein', 'settings.local.json');

/** Project servers the user approved (Claude Code keeps the same list in its local settings). */
function approvedProjectServers(root: string): Set<string> {
  const names = new Set<string>();
  for (const file of [localSettings(root), path.join(root, '.claude', 'settings.local.json')]) {
    try {
      for (const n of JSON.parse(readFileSync(file, 'utf8'))?.enabledMcpjsonServers ?? []) names.add(String(n));
    } catch {}
  }
  return names;
}

export function approveProjectServer(root: string, name: string): void {
  updateJsonFileSync(localSettings(root), (data) => {
    data.enabledMcpjsonServers = [...new Set([...(data.enabledMcpjsonServers ?? []), name])];
  });
}

/** Every configured server; later sources don't override earlier names (project → rein → claude). */
export function loadServers(root: string): ServerEntry[] {
  const approved = approvedProjectServers(root);
  const claudeJson = process.env.REIN_CLAUDE_JSON ?? path.join(os.homedir(), '.claude.json');
  const sources: [ServerSource, Record<string, ServerConfig>][] = [
    ['project', servers(path.join(root, '.mcp.json'))],
    ['rein', servers(path.join(reinConfigDir(), 'mcp.json'))],
    ['claude', {...servers(claudeJson), ...servers(claudeJson, (j) => j?.projects?.[root]?.mcpServers)}],
    // Installed plugins' servers (installing the plugin was the consent), as `<plugin>-<name>`.
    ['plugin', Object.fromEntries(loadPlugins(root).flatMap((p) => Object.entries(p.mcpServers ?? {}).map(([n, c]) => [`${p.name}-${n}`, c as ServerConfig])))],
  ];
  const out: ServerEntry[] = [];
  for (const [source, map] of sources) {
    for (const [name, config] of Object.entries(map)) {
      if (out.some((s) => s.name === name) || !config || typeof config !== 'object') continue;
      out.push({name, config: expandDeep(config), source, approved: source !== 'project' || approved.has(name)});
    }
  }
  return out;
}

export type ServerScope = 'project' | 'user';

/** Where a scope's servers live: the project's shared .mcp.json, or the user's ~/.rein/mcp.json. */
export const scopeFile = (root: string, scope: ServerScope) => (scope === 'project' ? path.join(root, '.mcp.json') : path.join(reinConfigDir(), 'mcp.json'));

export const validServerName = (name: string) => /^[A-Za-z0-9_-]{1,40}$/.test(name);

/**
 * Add (or replace) a server in a scope's file. A project server added through the agent's tool
 * is approved at the same time — the user approved the call that showed its command.
 */
export function addServer(root: string, scope: ServerScope, name: string, config: ServerConfig): string {
  const file = scopeFile(root, scope);
  updateJsonFileSync(file, (data) => {
    data.mcpServers = {...(data.mcpServers ?? {}), [name]: config};
  });
  if (scope === 'project') approveProjectServer(root, name);
  return file;
}

/** Remove a server from whichever Rein-managed file defines it; undefined if none does. */
export function removeServer(root: string, name: string): string | undefined {
  for (const scope of ['project', 'user'] as const) {
    const file = scopeFile(root, scope);
    let found = false;
    try {
      found = !!JSON.parse(readFileSync(file, 'utf8'))?.mcpServers?.[name];
    } catch {}
    if (!found) continue;
    updateJsonFileSync(file, (data) => {
      delete data.mcpServers[name];
    });
    return file;
  }
  return undefined;
}
