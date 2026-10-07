import { ToolError } from '../tools/fs.js';
import { addServer, removeServer, validServerName } from './config.js';
import { mcpToolName } from './manager.js';
const SOURCE = { project: '.mcp.json (project)', rein: '~/.rein/mcp.json (user)', claude: '~/.claude.json (claude mcp add)' };
/**
 * The agent's own MCP management — no hand-edited config needed:
 * mcp_list (read-only), mcp_add (always asks the user: it runs a command or contacts a URL),
 * mcp_remove, and mcp_call (use a server's tool in the same turn — new tools otherwise reach the
 * model on its next message; the called tool keeps its own approval and permission rules).
 */
export function mcpTools(deps) {
    const describeServer = (name) => {
        const s = deps.mcp.list().find((x) => x.name === name);
        if (!s)
            return `${name}: not configured`;
        const tools = s.toolNames.length ? `\n  tools: ${s.toolNames.join(', ')}` : '';
        return `${s.name} — ${s.status}${s.error ? ` (${s.error})` : ''} · ${s.transport}: ${s.target} · from ${SOURCE[s.source] ?? s.source}${tools}`;
    };
    return [
        {
            name: 'mcp_list',
            label: 'McpList',
            description: 'List MCP servers, their status and tools.',
            inputSchema: { type: 'object', properties: {} },
            mutating: false,
            summarize: () => 'servers',
            async run() {
                const names = deps.mcp.list().map((s) => s.name);
                return { ok: true, text: names.length ? names.map(describeServer).join('\n') : 'No MCP servers configured. Add one with mcp_add.' };
            },
        },
        {
            name: 'mcp_add',
            label: 'McpAdd',
            description: 'Add an MCP server.',
            describe: () => [
                'Add an MCP server and connect to it; its tools become available (use them right away through mcp_call, or directly from your next message).',
                '- stdio: command (+ args, env), e.g. command "npx", args ["-y", "@modelcontextprotocol/server-github"], env {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}.',
                '- remote: url (+ transport "http" (default) or "sse", headers).',
                '- scope: "project" (default; .mcp.json, shared with the repo) or "user" (~/.rein/mcp.json, all projects).',
                '- Use ${VAR} for secrets instead of pasting them. The user always approves an add (it runs a command or contacts a URL).',
            ].join('\n'),
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short server name (letters, digits, - and _)' },
                    command: { type: 'string', description: 'stdio: the program to run' },
                    args: { type: 'array', items: { type: 'string' }, description: 'stdio: its arguments' },
                    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'stdio: extra environment variables' },
                    url: { type: 'string', description: 'remote: the server URL' },
                    transport: { type: 'string', enum: ['http', 'sse'], description: 'remote: transport (default http)' },
                    headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'remote: HTTP headers' },
                    scope: { type: 'string', enum: ['project', 'user'], description: 'Where to save it (default project)' },
                },
                required: ['name'],
            },
            mutating: true,
            alwaysAsk: true,
            summarize: (a) => `${a?.name ?? ''} → ${a?.url ?? [a?.command, ...(a?.args ?? [])].filter(Boolean).join(' ')}`.slice(0, 120),
            async run(_ctx, args) {
                const name = String(args?.name ?? '');
                if (!validServerName(name))
                    throw new ToolError('name must be 1–40 letters, digits, - or _');
                let config;
                if (typeof args.url === 'string' && args.url) {
                    try {
                        new URL(args.url);
                    }
                    catch {
                        throw new ToolError(`not a valid URL: ${args.url}`);
                    }
                    config = { type: args.transport === 'sse' ? 'sse' : 'http', url: args.url, ...(args.headers ? { headers: args.headers } : {}) };
                }
                else if (typeof args.command === 'string' && args.command.trim()) {
                    config = { command: args.command.trim(), ...(Array.isArray(args.args) ? { args: args.args.map(String) } : {}), ...(args.env ? { env: args.env } : {}) };
                }
                else
                    throw new ToolError('give either command (stdio) or url (remote)');
                const scope = args.scope === 'user' ? 'user' : 'project';
                const file = addServer(deps.root(), scope, name, config);
                await deps.mcp.start();
                const s = deps.mcp.list().find((x) => x.name === name);
                const ok = s?.status === 'connected';
                const hint = ok ? `\nCall its tools now with mcp_call {server: "${name}", tool, args}; from your next message they're also available directly as ${mcpToolName(name, '<tool>')}.` : '\nIt was saved but did not connect — check the command/URL and environment, then mcp_remove and add again.';
                return { ok, text: `Saved to ${file}.\n${describeServer(name)}${hint}` };
            },
        },
        {
            name: 'mcp_remove',
            label: 'McpRemove',
            description: 'Remove an MCP server.',
            inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Server name (see mcp_list)' } }, required: ['name'] },
            mutating: true,
            summarize: (a) => String(a?.name ?? ''),
            async run(_ctx, args) {
                const name = String(args?.name ?? '');
                const s = deps.mcp.list().find((x) => x.name === name);
                if (s?.source === 'claude')
                    throw new ToolError(`"${name}" was added with Claude Code; remove it with \`claude mcp remove ${name}\``);
                const file = removeServer(deps.root(), name);
                if (!file)
                    throw new ToolError(`no MCP server named "${name}" in .mcp.json or ~/.rein/mcp.json`);
                await deps.mcp.start(); // drops the connection and its tools
                return { ok: true, text: `Removed "${name}" from ${file} and disconnected.` };
            },
        },
        {
            name: 'mcp_call',
            label: 'McpCall',
            description: 'Call a tool on a connected MCP server.',
            describe: () => 'Call a tool on a connected MCP server (see mcp_list) — handy right after mcp_add, before its tools appear directly. The call gets the same approval and permission rules as the tool itself.',
            inputSchema: {
                type: 'object',
                properties: {
                    server: { type: 'string' },
                    tool: { type: 'string' },
                    args: { type: 'object', description: "The tool's arguments" },
                },
                required: ['server', 'tool'],
            },
            mutating: false,
            summarize: (a) => `${a?.server ?? ''}:${a?.tool ?? ''}`,
            async run(ctx, args) {
                const s = deps.mcp.list().find((x) => x.name === args?.server);
                if (!s)
                    throw new ToolError(`no MCP server named "${args?.server}" (see mcp_list)`);
                if (s.status !== 'connected')
                    throw new ToolError(`"${s.name}" is ${s.status}${s.error ? `: ${s.error}` : ''}`);
                if (!s.toolNames.includes(String(args?.tool)))
                    throw new ToolError(`"${s.name}" has no tool "${args?.tool}"; it has: ${s.toolNames.join(', ')}`);
                // Through the host, so the tool's own approval and permission rules apply.
                return deps.call(mcpToolName(s.name, String(args.tool)), args.args ?? {}, ctx.origin);
            },
        },
    ];
}
