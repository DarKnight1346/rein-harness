import os from 'node:os';
import type {Account} from '../providers/types.js';
import {AppServerClient} from '../providers/codex/appServer.js';

/**
 * Your ChatGPT apps' tools (here: Pets), through the official `codex app-server`: Codex holds the
 * sign-in and talks to ChatGPT, Rein only calls the tools Codex's `codex_apps` MCP server offers
 * (`mcpServer/tool/call`). No model turn, no token in Rein. This app-server is Rein's own, with
 * apps on; chat sessions keep them off (catalog.ts). It's closed after a couple of idle minutes.
 */
export type AppTool = {name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean; destructive: boolean};
export type AppCall = {ok: boolean; text: string; structured?: any};

const SERVER = 'codex_apps';
const IDLE_MS = 2 * 60_000;

export class CodexAppsBridge {
  private conn: Promise<{client: AppServerClient; threadId: string}> | undefined;
  private idle: NodeJS.Timeout | undefined;

  constructor(private readonly account: () => Account | undefined, private readonly start: typeof AppServerClient.start = AppServerClient.start) {}

  get available(): boolean {
    return !!this.account();
  }

  private connect(): Promise<{client: AppServerClient; threadId: string}> {
    this.touch();
    this.conn ??= (async () => {
      const account = this.account();
      if (!account) throw new Error('no Codex account is signed in (pets come from your ChatGPT account through Codex)');
      const client = await this.start(account, {experimental: true});
      client.onExit(() => (this.conn = undefined));
      const t = await client.request('thread/start', {cwd: os.tmpdir(), ephemeral: true});
      return {client, threadId: t.thread.id as string};
    })();
    this.conn.catch(() => (this.conn = undefined));
    return this.conn;
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  /** The app tools whose names start with `prefix` (e.g. `pets.`), as Codex describes them. */
  async tools(prefix: string): Promise<AppTool[]> {
    const {client} = await this.connect();
    const status = await client.request('mcpServerStatus/list', {});
    const tools = (status?.data ?? []).find((s: any) => s.name === SERVER)?.tools ?? {};
    return Object.values<any>(tools)
      .filter((t) => typeof t?.name === 'string' && t.name.startsWith(prefix))
      .map((t) => ({name: t.name, description: String(t.description ?? ''), inputSchema: t.inputSchema ?? {type: 'object', properties: {}}, readOnly: t.annotations?.readOnlyHint === true, destructive: t.annotations?.destructiveHint === true}));
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<AppCall> {
    const {client, threadId} = await this.connect();
    const r = await client.request('mcpServer/tool/call', {server: SERVER, threadId, tool, arguments: args});
    const text = (r?.content ?? []).map((c: any) => (c?.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
    return {ok: !r?.isError, text, structured: r?.structuredContent};
  }

  close(): void {
    clearTimeout(this.idle);
    void this.conn?.then(({client}) => client.close(), () => {});
    this.conn = undefined;
  }
}
