import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reinHome} from '../store/paths.js';
import {updateJsonFileSync} from '../store/json.js';

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
export type ServerSource = 'project' | 'rein' | 'claude';
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
    ['rein', servers(path.join(reinHome(), 'mcp.json'))],
    ['claude', {...servers(claudeJson), ...servers(claudeJson, (j) => j?.projects?.[root]?.mcpServers)}],
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
