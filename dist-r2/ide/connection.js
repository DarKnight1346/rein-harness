import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
export const ideLockDir = () => process.env.REIN_IDE_LOCK_DIR ?? path.join(os.homedir(), '.claude', 'ide');
const real = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return path.resolve(p);
    }
};
const alive = (pid) => {
    if (!pid)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
};
/** Running editors whose workspace contains `cwd`, best first (the one that launched us, if any). */
export function findIdes(cwd = process.cwd()) {
    let files;
    try {
        files = readdirSync(ideLockDir()).filter((f) => /^\d+\.lock$/.test(f));
    }
    catch {
        return [];
    }
    const here = real(cwd);
    const locks = [];
    for (const f of files) {
        try {
            const d = JSON.parse(readFileSync(path.join(ideLockDir(), f), 'utf8'));
            const lock = {
                port: Number(f.replace('.lock', '')),
                workspaceFolders: Array.isArray(d.workspaceFolders) ? d.workspaceFolders.map(String) : [],
                pid: typeof d.pid === 'number' ? d.pid : undefined,
                ideName: typeof d.ideName === 'string' ? d.ideName : 'IDE',
                transport: d.transport === 'ws' ? 'ws' : 'sse',
                authToken: typeof d.authToken === 'string' ? d.authToken : undefined,
                runningInWindows: d.runningInWindows === true,
            };
            if (!alive(lock.pid))
                continue;
            if (!lock.workspaceFolders.some((w) => here === real(w) || here.startsWith(real(w) + path.sep)))
                continue;
            locks.push(lock);
        }
        catch {
            /* unreadable or half-written lock: skip */
        }
    }
    // Launched from the editor's terminal: it sets CLAUDE_CODE_SSE_PORT to its server's port.
    const launchedFrom = Number(process.env.CLAUDE_CODE_SSE_PORT);
    return locks.sort((a, b) => Number(b.port === launchedFrom) - Number(a.port === launchedFrom));
}
/** MCP over the extension's WebSocket, with its auth header (Node's WebSocket accepts headers). */
class IdeWebSocketTransport {
    url;
    token;
    ws;
    onclose;
    onerror;
    onmessage;
    constructor(url, token) {
        this.url = url;
        this.token = token;
    }
    start() {
        return new Promise((resolve, reject) => {
            const init = { protocols: ['mcp'], headers: this.token ? { 'X-Claude-Code-Ide-Authorization': this.token } : {} };
            const ws = new WebSocket(this.url, init);
            this.ws = ws;
            let open = false;
            ws.onopen = () => {
                open = true;
                resolve();
            };
            ws.onerror = () => {
                const err = new Error(`couldn't connect to ${this.url}`);
                if (!open)
                    reject(err);
                else
                    this.onerror?.(err);
            };
            ws.onclose = () => this.onclose?.();
            ws.onmessage = (ev) => {
                try {
                    this.onmessage?.(JSON.parse(String(ev.data)));
                }
                catch (err) {
                    this.onerror?.(err);
                }
            };
        });
    }
    async send(message) {
        this.ws?.send(JSON.stringify(message));
    }
    async close() {
        this.ws?.close();
    }
}
/** A live connection to one editor. Emits `selection`, `mention` ({filePath, lineStart?, lineEnd?}), `close`. */
export class IdeConnection extends EventEmitter {
    lock;
    client;
    selection;
    constructor(lock, client) {
        super();
        this.lock = lock;
        this.client = client;
    }
    static async connect(lock) {
        const client = new Client({ name: 'rein', version: '0.1.0' }, { capabilities: {} });
        const transport = lock.transport === 'ws' ? new IdeWebSocketTransport(`ws://127.0.0.1:${lock.port}`, lock.authToken) : new SSEClientTransport(new URL(`http://127.0.0.1:${lock.port}/sse`));
        const conn = new IdeConnection(lock, client);
        client.fallbackNotificationHandler = async (n) => conn.onNotification(n.method, (n.params ?? {}));
        client.onclose = () => conn.emit('close');
        await client.connect(transport);
        return conn;
    }
    onNotification(method, p) {
        if (method === 'selection_changed') {
            const text = typeof p.text === 'string' ? p.text : '';
            this.selection =
                p.filePath && text.trim()
                    ? { filePath: String(p.filePath), text, startLine: (p.selection?.start?.line ?? 0) + 1, endLine: (p.selection?.end?.line ?? 0) + 1 }
                    : undefined;
            this.emit('selection', this.selection);
        }
        else if (method === 'at_mentioned' && p.filePath) {
            this.emit('mention', { filePath: String(p.filePath), lineStart: p.lineStart !== undefined ? p.lineStart + 1 : undefined, lineEnd: p.lineEnd !== undefined ? p.lineEnd + 1 : undefined });
        }
    }
    /** Tools the editor offers (they differ between extensions and versions). */
    async toolNames() {
        return (await this.client.listTools()).tools.map((t) => t.name);
    }
    async text(name, args) {
        const res = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 24 * 3600_000 });
        return (res.content ?? []).filter((c) => c.type === 'text').map((c) => String(c.text));
    }
    /**
     * Show a proposed change as a diff in the editor and wait for the user: Accept (FILE_SAVED, with
     * the contents they accepted, possibly edited) or Reject / closing the tab.
     */
    async openDiff(filePath, newContents, tabName) {
        const out = await this.text('openDiff', { old_file_path: filePath, new_file_path: filePath, new_file_contents: newContents, tab_name: tabName });
        if (out[0] === 'FILE_SAVED')
            return { answer: 'accepted', contents: out[1] };
        return { answer: 'rejected' };
    }
    async closeDiffs() {
        await this.text('closeAllDiffTabs', {}).catch(() => { });
    }
    /** The editor's problems (errors, warnings) for one file, or the whole workspace. */
    async diagnostics(filePath) {
        const text = (await this.text('getDiagnostics', filePath ? { uri: `file://${filePath}` } : {})).join('\n').trim();
        // Some editors (claudecode.nvim) answer "no problems" as an empty JSON list.
        return /^\[\s*\]$/.test(text) ? '' : text;
    }
    async close() {
        await this.client.close().catch(() => { });
    }
}
