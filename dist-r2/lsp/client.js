import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { killTree } from '../util/platform.js';
import { Rpc } from './rpc.js';
/**
 * A running language server for one project root. Rein tells it about files by their full text
 * (didOpen / didChange with full sync), so it always sees what's on disk, and keeps the latest
 * diagnostics it publishes per file.
 */
export class LspClient {
    root;
    languageIdFor;
    proc;
    rpc;
    ready;
    versions = new Map();
    texts = new Map();
    /** Latest diagnostics per file URI, and how many times they've been published. */
    diags = new Map();
    waiters = [];
    /** The server answers `textDocument/diagnostic` (LSP 3.17 pull diagnostics, e.g. TypeScript 7). */
    pull = false;
    lastPublishAt = 0;
    lastUsed = Date.now();
    constructor(root, command, args, languageIdFor, initializationOptions, env) {
        this.root = root;
        this.languageIdFor = languageIdFor;
        // Windows: npm's .cmd shims only run through a shell (Node refuses to spawn them directly).
        const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
        this.proc = spawn(shim ? `"${command}"` : command, args, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env }, detached: process.platform !== 'win32', shell: shim });
        this.rpc = new Rpc(this.proc);
        this.rpc.on('notification', (method, params) => {
            if (method !== 'textDocument/publishDiagnostics' || !params?.uri)
                return;
            const prev = this.diags.get(params.uri);
            const entry = { list: params.diagnostics ?? [], n: (prev?.n ?? 0) + 1 };
            this.diags.set(params.uri, entry);
            this.lastPublishAt = Date.now();
            for (const w of this.waiters.filter((w) => w.uri === params.uri && entry.n > w.after))
                w.resolve();
            this.waiters = this.waiters.filter((w) => !(w.uri === params.uri && entry.n > w.after));
        });
        this.ready = this.rpc
            .request('initialize', {
            processId: process.pid,
            rootUri: pathToFileURL(root).href,
            workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
            ...(initializationOptions ? { initializationOptions } : {}),
            capabilities: {
                textDocument: { synchronization: { didSave: true }, publishDiagnostics: { relatedInformation: false }, diagnostic: { dynamicRegistration: false }, hover: { contentFormat: ['plaintext', 'markdown'] }, definition: {}, references: {} },
                workspace: { workspaceFolders: true, configuration: true },
            },
        }, 30_000)
            .then((r) => {
            this.pull = !!r?.capabilities?.diagnosticProvider;
            this.rpc.notify('initialized', {});
        });
        this.ready.catch(() => undefined);
    }
    get alive() {
        return !this.rpc.isClosed && this.proc.exitCode === null;
    }
    async whenReady(timeoutMs) {
        let timer;
        const ok = await Promise.race([this.ready.then(() => true, () => false), new Promise((r) => (timer = setTimeout(() => r(false), timeoutMs)))]);
        clearTimeout(timer);
        return ok;
    }
    uri(file) {
        return pathToFileURL(file).href;
    }
    /** Tell the server a file's current contents from disk (open it, or send the change). True = something was sent. */
    sync(file) {
        this.lastUsed = Date.now();
        let text;
        try {
            text = readFileSync(file, 'utf8');
        }
        catch {
            this.close(file);
            return false;
        }
        const uri = this.uri(file);
        const v = this.versions.get(uri);
        if (v === undefined) {
            this.versions.set(uri, 1);
            this.texts.set(uri, text);
            this.rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.languageIdFor(file), version: 1, text } });
            return true;
        }
        if (this.texts.get(uri) === text)
            return false;
        this.versions.set(uri, v + 1);
        this.texts.set(uri, text);
        this.rpc.notify('textDocument/didChange', { textDocument: { uri, version: v + 1 }, contentChanges: [{ text }] });
        return true;
    }
    close(file) {
        const uri = this.uri(file);
        if (!this.versions.has(uri))
            return;
        this.versions.delete(uri);
        this.texts.delete(uri);
        this.diags.delete(uri);
        this.rpc.notify('textDocument/didClose', { textDocument: { uri } });
    }
    isOpen(file) {
        return this.versions.has(this.uri(file));
    }
    /** How many times diagnostics were published for a file so far. */
    publishCount(file) {
        return this.diags.get(this.uri(file))?.n ?? 0;
    }
    diagnostics(file) {
        return this.diags.get(this.uri(file))?.list;
    }
    /** The files the server has open. */
    openFiles() {
        return [...this.versions.keys()].map((uri) => fileURLToPath(uri));
    }
    /** Every file with diagnostics (the open ones). */
    allDiagnostics() {
        return [...this.diags].map(([uri, d]) => ({ file: fileURLToPath(uri), list: d.list }));
    }
    /**
     * Wait for diagnostics published after the `after`-th time (with a short settle, since servers
     * often publish twice: syntax, then types). False on timeout.
     */
    async waitForDiagnostics(file, after, timeoutMs, settleMs = 250) {
        const uri = this.uri(file);
        if (this.pull) {
            // Pull model: ask for them (the server computes them for the text it has now).
            try {
                const r = await this.rpc.request('textDocument/diagnostic', { textDocument: { uri } }, timeoutMs);
                const prev = this.diags.get(uri);
                this.diags.set(uri, { list: r?.kind === 'unchanged' ? (prev?.list ?? []) : (r?.items ?? []), n: (prev?.n ?? 0) + 1 });
                return true;
            }
            catch {
                return false;
            }
        }
        if ((this.diags.get(uri)?.n ?? 0) <= after) {
            let timer;
            const got = await Promise.race([
                new Promise((resolve) => this.waiters.push({ uri, after, resolve: () => resolve(true) })),
                new Promise((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
            ]);
            clearTimeout(timer);
            if (!got)
                return false;
        }
        await new Promise((r) => setTimeout(r, settleMs));
        return true;
    }
    /**
     * After a change, wait for a push server to finish re-checking: until every file has a fresh
     * report, or reports stop arriving for `quietMs`, or nothing at all comes for `idleMs`. Servers
     * only republish files whose problems changed, so a missing report means "same as before".
     */
    async waitSettled(entries, timeoutMs, idleMs = 1000, quietMs = 250) {
        const start = Date.now();
        for (;;) {
            const now = Date.now();
            if (entries.every((e) => this.publishCount(e.file) > e.after))
                return void (await new Promise((r) => setTimeout(r, 100)));
            const heard = this.lastPublishAt > start;
            if (heard && now - this.lastPublishAt >= quietMs)
                return;
            if (!heard && now - start >= idleMs)
                return;
            if (now - start >= timeoutMs)
                return;
            await new Promise((r) => setTimeout(r, 25));
        }
    }
    /** Stop the server: polite shutdown, then the whole process tree. */
    async shutdown() {
        try {
            if (this.alive) {
                await this.rpc.request('shutdown', null, 2000).catch(() => undefined);
                this.rpc.notify('exit', null);
            }
        }
        finally {
            this.rpc.close();
            setTimeout(() => {
                if (this.proc.exitCode === null)
                    killTree(this.proc.pid, 'SIGKILL');
            }, 1000).unref();
            killTree(this.proc.pid, 'SIGTERM');
        }
    }
}
