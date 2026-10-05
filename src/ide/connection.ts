import {EventEmitter} from 'node:events';
import {readdirSync, readFileSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';

/**
 * Editor integration through the Claude Code IDE extensions (VS Code, Cursor, Windsurf, JetBrains).
 * The extension runs a local MCP server and announces it in `~/.claude/ide/<port>.lock`
 * (`{workspaceFolders, pid, ideName, transport: "ws", authToken}`); clients connect over a
 * WebSocket (subprotocol `mcp`, header `X-Claude-Code-Ide-Authorization`). It pushes
 * `selection_changed` / `at_mentioned` notifications and offers tools such as `openDiff`
 * (answers FILE_SAVED / DIFF_REJECTED / TAB_CLOSED), `getDiagnostics` and `closeAllDiffTabs`.
 * Rein speaks the same protocol, so the extension you already have works with it.
 */
export type IdeLock = {port: number; workspaceFolders: string[]; pid?: number; ideName: string; transport: 'ws' | 'sse'; authToken?: string; runningInWindows?: boolean};

export type IdeSelection = {filePath: string; text: string; startLine: number; endLine: number};

export const ideLockDir = () => process.env.REIN_IDE_LOCK_DIR ?? path.join(os.homedir(), '.claude', 'ide');

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const alive = (pid?: number) => {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Running editors whose workspace contains `cwd`, best first (the one that launched us, if any). */
export function findIdes(cwd = process.cwd()): IdeLock[] {
  let files: string[];
  try {
    files = readdirSync(ideLockDir()).filter((f) => /^\d+\.lock$/.test(f));
  } catch {
    return [];
  }
  const here = real(cwd);
  const locks: IdeLock[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(path.join(ideLockDir(), f), 'utf8'));
      const lock: IdeLock = {
        port: Number(f.replace('.lock', '')),
        workspaceFolders: Array.isArray(d.workspaceFolders) ? d.workspaceFolders.map(String) : [],
        pid: typeof d.pid === 'number' ? d.pid : undefined,
        ideName: typeof d.ideName === 'string' ? d.ideName : 'IDE',
        transport: d.transport === 'ws' ? 'ws' : 'sse',
        authToken: typeof d.authToken === 'string' ? d.authToken : undefined,
        runningInWindows: d.runningInWindows === true,
      };
      if (!alive(lock.pid)) continue;
      if (!lock.workspaceFolders.some((w) => here === real(w) || here.startsWith(real(w) + path.sep))) continue;
      locks.push(lock);
    } catch {
      /* unreadable or half-written lock: skip */
    }
  }
  // Launched from the editor's terminal: it sets CLAUDE_CODE_SSE_PORT to its server's port.
  const launchedFrom = Number(process.env.CLAUDE_CODE_SSE_PORT);
  return locks.sort((a, b) => Number(b.port === launchedFrom) - Number(a.port === launchedFrom));
}

/** MCP over the extension's WebSocket, with its auth header (Node's WebSocket accepts headers). */
class IdeWebSocketTransport implements Transport {
  private ws?: WebSocket;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  constructor(private readonly url: string, private readonly token?: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const init = {protocols: ['mcp'], headers: this.token ? {'X-Claude-Code-Ide-Authorization': this.token} : {}};
      const ws = new WebSocket(this.url, init as unknown as string[]);
      this.ws = ws;
      let open = false;
      ws.onopen = () => {
        open = true;
        resolve();
      };
      ws.onerror = () => {
        const err = new Error(`couldn't connect to ${this.url}`);
        if (!open) reject(err);
        else this.onerror?.(err);
      };
      ws.onclose = () => this.onclose?.();
      ws.onmessage = (ev) => {
        try {
          this.onmessage?.(JSON.parse(String(ev.data)) as JSONRPCMessage);
        } catch (err) {
          this.onerror?.(err as Error);
        }
      };
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.ws?.send(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.ws?.close();
  }
}

export type DiffAnswer = 'accepted' | 'rejected';

/** A live connection to one editor. Emits `selection`, `mention` ({filePath, lineStart?, lineEnd?}), `close`. */
export class IdeConnection extends EventEmitter {
  selection: IdeSelection | undefined;
  private constructor(readonly lock: IdeLock, private readonly client: Client) {
    super();
  }

  static async connect(lock: IdeLock): Promise<IdeConnection> {
    const client = new Client({name: 'rein', version: '0.1.0'}, {capabilities: {}});
    const transport: Transport =
      lock.transport === 'ws' ? new IdeWebSocketTransport(`ws://127.0.0.1:${lock.port}`, lock.authToken) : new SSEClientTransport(new URL(`http://127.0.0.1:${lock.port}/sse`));
    const conn = new IdeConnection(lock, client);
    client.fallbackNotificationHandler = async (n) => conn.onNotification(n.method, (n.params ?? {}) as Record<string, any>);
    client.onclose = () => conn.emit('close');
    await client.connect(transport);
    return conn;
  }

  private onNotification(method: string, p: Record<string, any>): void {
    if (method === 'selection_changed') {
      const text = typeof p.text === 'string' ? p.text : '';
      this.selection =
        p.filePath && text.trim()
          ? {filePath: String(p.filePath), text, startLine: (p.selection?.start?.line ?? 0) + 1, endLine: (p.selection?.end?.line ?? 0) + 1}
          : undefined;
      this.emit('selection', this.selection);
    } else if (method === 'at_mentioned' && p.filePath) {
      this.emit('mention', {filePath: String(p.filePath), lineStart: p.lineStart !== undefined ? p.lineStart + 1 : undefined, lineEnd: p.lineEnd !== undefined ? p.lineEnd + 1 : undefined});
    }
  }

  /** Tools the editor offers (they differ between extensions and versions). */
  async toolNames(): Promise<string[]> {
    return (await this.client.listTools()).tools.map((t) => t.name);
  }

  private async text(name: string, args: Record<string, unknown>): Promise<string[]> {
    const res: any = await this.client.callTool({name, arguments: args}, undefined, {timeout: 24 * 3600_000});
    return (res.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => String(c.text));
  }

  /**
   * Show a proposed change as a diff in the editor and wait for the user: Accept (FILE_SAVED, with
   * the contents they accepted, possibly edited) or Reject / closing the tab.
   */
  async openDiff(filePath: string, newContents: string, tabName: string): Promise<{answer: DiffAnswer; contents?: string}> {
    const out = await this.text('openDiff', {old_file_path: filePath, new_file_path: filePath, new_file_contents: newContents, tab_name: tabName});
    if (out[0] === 'FILE_SAVED') return {answer: 'accepted', contents: out[1]};
    return {answer: 'rejected'};
  }

  async closeDiffs(): Promise<void> {
    await this.text('closeAllDiffTabs', {}).catch(() => {});
  }

  /** The editor's problems (errors, warnings) for one file, or the whole workspace. */
  async diagnostics(filePath?: string): Promise<string> {
    const text = (await this.text('getDiagnostics', filePath ? {uri: `file://${filePath}`} : {})).join('\n').trim();
    // Some editors (claudecode.nvim) answer "no problems" as an empty JSON list.
    return /^\[\s*\]$/.test(text) ? '' : text;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }
}
