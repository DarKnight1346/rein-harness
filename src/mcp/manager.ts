import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ToolListChangedNotificationSchema} from '@modelcontextprotocol/sdk/types.js';
import {ToolError, type ToolImage} from '../tools/fs.js';
import type {ToolDef} from '../tools/registry.js';
import {loadServers, type ServerConfig, type ServerEntry} from './config.js';

export type ServerStatus = 'connecting' | 'connected' | 'failed' | 'needs-approval';
type McpTool = {name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: {readOnlyHint?: boolean; title?: string}};
type Server = ServerEntry & {status: ServerStatus; error?: string; client?: Client; tools: McpTool[]};

const CONNECT_TIMEOUT_MS = 30_000;
/** Tool names travel through two prefixes (Claude: mcp__rein__…); providers cap names at 64. */
const MAX_NAME = 50;
/** MCP tool results larger than this are cut (the model gets the start and a note). */
const MAX_RESULT = 60_000;

const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/** `mcp__<server>__<tool>` (Claude Code's naming, so permission rules carry over), shortened if long. */
export function mcpToolName(server: string, tool: string): string {
  const full = `mcp__${clean(server)}__${clean(tool)}`;
  if (full.length <= MAX_NAME) return full;
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 6);
  return `${full.slice(0, MAX_NAME - 7)}_${hash}`;
}

/**
 * MCP client side: connects to the user's configured servers (stdio, streamable HTTP, SSE) and
 * offers their tools to every model as Rein tools, through the normal permission rules and
 * approvals (tools marked readOnlyHint skip approval). Emits `change` when servers or tools change.
 */
export class McpManager extends EventEmitter {
  private servers = new Map<string, Server>();

  constructor(private readonly root: string) {
    super();
  }

  /** (Re)read the configs and connect to every approved server not yet connected. */
  async start(): Promise<void> {
    const entries = loadServers(this.root);
    for (const old of this.servers.values()) if (!entries.some((e) => e.name === old.name)) await this.close(old.name);
    await Promise.all(
      entries.map(async (e) => {
        const existing = this.servers.get(e.name);
        if (existing?.status === 'connected' && JSON.stringify(existing.config) === JSON.stringify(e.config)) return;
        if (existing) await this.close(e.name);
        if (!e.approved) {
          this.servers.set(e.name, {...e, status: 'needs-approval', tools: []});
          return;
        }
        await this.connect(e);
      }),
    );
    this.emit('change');
  }

  private async connect(e: ServerEntry): Promise<void> {
    const server: Server = {...e, status: 'connecting', tools: []};
    this.servers.set(e.name, server);
    this.emit('change');
    const client = new Client({name: 'rein', version: '0.1.0'}, {capabilities: {}});
    try {
      await withTimeout(client.connect(transportFor(e.config, this.root)), CONNECT_TIMEOUT_MS, 'timed out connecting');
      server.client = client;
      server.tools = await this.listTools(client);
      server.status = 'connected';
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        server.tools = await this.listTools(client).catch(() => server.tools);
        this.emit('change');
      });
      client.onclose = () => {
        if (this.servers.get(e.name) === server) {
          server.status = 'failed';
          server.error = 'disconnected';
          server.tools = [];
          this.emit('change');
        }
      };
    } catch (err) {
      server.status = 'failed';
      server.error = (err as Error).message;
      await client.close().catch(() => {});
    }
    this.emit('change');
  }

  private async listTools(client: Client): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? {cursor} : {});
      out.push(...(page.tools as McpTool[]));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  async close(name: string): Promise<void> {
    const s = this.servers.get(name);
    this.servers.delete(name);
    await s?.client?.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((n) => this.close(n)));
  }

  /** Reconnect one server (after fixing its config or approving it). */
  async reconnect(name: string): Promise<void> {
    await this.close(name);
    await this.start();
  }

  list(): {name: string; source: string; status: ServerStatus; error?: string; tools: number; transport: string}[] {
    return [...this.servers.values()].map((s) => ({
      name: s.name,
      source: s.source,
      status: s.status,
      error: s.error,
      tools: s.tools.length,
      transport: 'url' in s.config ? s.config.type : 'stdio',
    }));
  }

  /** Every connected server's tools as Rein tools. */
  tools(): ToolDef[] {
    const out: ToolDef[] = [];
    for (const s of this.servers.values()) {
      if (s.status !== 'connected' || !s.client) continue;
      for (const t of s.tools) out.push(this.toolDef(s, t));
    }
    return out;
  }

  private toolDef(s: Server, t: McpTool): ToolDef {
    const client = s.client!;
    return {
      name: mcpToolName(s.name, t.name),
      label: `${s.name}:${t.name}`,
      description: `${t.description ?? t.annotations?.title ?? t.name} (MCP server "${s.name}")`,
      inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {type: 'object', properties: {}},
      // Only tools that declare themselves read-only skip approval.
      mutating: t.annotations?.readOnlyHint !== true,
      summarize: (a) => JSON.stringify(a ?? {}).slice(0, 100),
      async run(_ctx, args) {
        let res: any;
        try {
          res = await client.callTool({name: t.name, arguments: args ?? {}});
        } catch (err) {
          throw new ToolError(`MCP server "${s.name}": ${(err as Error).message}`);
        }
        const texts: string[] = [];
        const images: ToolImage[] = [];
        for (const c of res.content ?? []) {
          if (c.type === 'text') texts.push(c.text);
          else if (c.type === 'image') images.push({mime: c.mimeType, base64: c.data});
          else if (c.type === 'resource') texts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`);
          else if (c.type === 'resource_link') texts.push(`[resource ${c.uri}]`);
        }
        if (res.structuredContent && !texts.length) texts.push(JSON.stringify(res.structuredContent, null, 2));
        let text = texts.join('\n') || (images.length ? '(image)' : '(no output)');
        if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n… [MCP output truncated]`;
        return {ok: !res.isError, text, ...(images.length ? {images} : {})};
      },
    };
  }
}

function transportFor(config: ServerConfig, root: string) {
  if ('url' in config) {
    const url = new URL(config.url);
    const init = config.headers ? {requestInit: {headers: config.headers}} : undefined;
    return config.type === 'sse' ? new SSEClientTransport(url, init) : new StreamableHTTPClientTransport(url, init);
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: {...(process.env as Record<string, string>), ...(config.env ?? {})},
    cwd: root,
    stderr: 'ignore',
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}
