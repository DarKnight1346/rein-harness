import {spawn, type ChildProcess} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {killTree} from '../util/platform.js';
import {Rpc} from './rpc.js';

/** One diagnostic, as the server reported it (lines and columns 0-based, as in LSP). */
export type Diagnostic = {severity?: number; message: string; source?: string; code?: string | number; range: {start: {line: number; character: number}; end: {line: number; character: number}}};

/**
 * A running language server for one project root. Rein tells it about files by their full text
 * (didOpen / didChange with full sync), so it always sees what's on disk, and keeps the latest
 * diagnostics it publishes per file.
 */
export class LspClient {
  readonly proc: ChildProcess;
  private rpc: Rpc;
  private ready: Promise<void>;
  private versions = new Map<string, number>();
  private texts = new Map<string, string>();
  /** Latest diagnostics per file URI, and how many times they've been published. */
  private diags = new Map<string, {list: Diagnostic[]; n: number}>();
  private waiters: {uri: string; after: number; resolve(): void}[] = [];
  /** The server answers `textDocument/diagnostic` (LSP 3.17 pull diagnostics, e.g. TypeScript 7). */
  pull = false;
  private lastPublishAt = 0;
  lastUsed = Date.now();

  constructor(readonly root: string, command: string, args: string[], readonly languageIdFor: (file: string) => string, initializationOptions?: Record<string, unknown>) {
    // Windows: npm's .cmd shims only run through a shell (Node refuses to spawn them directly).
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    this.proc = spawn(shim ? `"${command}"` : command, args, {cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: process.env, detached: process.platform !== 'win32', shell: shim});
    this.rpc = new Rpc(this.proc);
    this.rpc.on('notification', (method: string, params: {uri?: string; diagnostics?: Diagnostic[]}) => {
      if (method !== 'textDocument/publishDiagnostics' || !params?.uri) return;
      const prev = this.diags.get(params.uri);
      const entry = {list: params.diagnostics ?? [], n: (prev?.n ?? 0) + 1};
      this.diags.set(params.uri, entry);
      this.lastPublishAt = Date.now();
      for (const w of this.waiters.filter((w) => w.uri === params.uri && entry.n > w.after)) w.resolve();
      this.waiters = this.waiters.filter((w) => !(w.uri === params.uri && entry.n > w.after));
    });
    this.ready = this.rpc
      .request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [{uri: pathToFileURL(root).href, name: path.basename(root)}],
        ...(initializationOptions ? {initializationOptions} : {}),
        capabilities: {
          textDocument: {synchronization: {didSave: true}, publishDiagnostics: {relatedInformation: false}, diagnostic: {dynamicRegistration: false}, hover: {contentFormat: ['plaintext', 'markdown']}, definition: {}, references: {}},
          workspace: {workspaceFolders: true, configuration: true},
        },
      }, 30_000)
      .then((r) => {
        this.pull = !!(r as {capabilities?: {diagnosticProvider?: unknown}})?.capabilities?.diagnosticProvider;
        this.rpc.notify('initialized', {});
      });
    this.ready.catch(() => undefined);
  }

  get alive(): boolean {
    return !this.rpc.isClosed && this.proc.exitCode === null;
  }

  async whenReady(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const ok = await Promise.race([this.ready.then(() => true, () => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), timeoutMs)))]);
    clearTimeout(timer);
    return ok;
  }

  private uri(file: string) {
    return pathToFileURL(file).href;
  }

  /** Tell the server a file's current contents from disk (open it, or send the change). True = something was sent. */
  sync(file: string): boolean {
    this.lastUsed = Date.now();
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      this.close(file);
      return false;
    }
    const uri = this.uri(file);
    const v = this.versions.get(uri);
    if (v === undefined) {
      this.versions.set(uri, 1);
      this.texts.set(uri, text);
      this.rpc.notify('textDocument/didOpen', {textDocument: {uri, languageId: this.languageIdFor(file), version: 1, text}});
      return true;
    }
    if (this.texts.get(uri) === text) return false;
    this.versions.set(uri, v + 1);
    this.texts.set(uri, text);
    this.rpc.notify('textDocument/didChange', {textDocument: {uri, version: v + 1}, contentChanges: [{text}]});
    return true;
  }

  close(file: string): void {
    const uri = this.uri(file);
    if (!this.versions.has(uri)) return;
    this.versions.delete(uri);
    this.texts.delete(uri);
    this.diags.delete(uri);
    this.rpc.notify('textDocument/didClose', {textDocument: {uri}});
  }

  isOpen(file: string): boolean {
    return this.versions.has(this.uri(file));
  }

  /** How many times diagnostics were published for a file so far. */
  publishCount(file: string): number {
    return this.diags.get(this.uri(file))?.n ?? 0;
  }

  diagnostics(file: string): Diagnostic[] | undefined {
    return this.diags.get(this.uri(file))?.list;
  }

  /** The files the server has open. */
  openFiles(): string[] {
    return [...this.versions.keys()].map((uri) => fileURLToPath(uri));
  }

  /** Every file with diagnostics (the open ones). */
  allDiagnostics(): {file: string; list: Diagnostic[]}[] {
    return [...this.diags].map(([uri, d]) => ({file: fileURLToPath(uri), list: d.list}));
  }

  /**
   * Wait for diagnostics published after the `after`-th time (with a short settle, since servers
   * often publish twice: syntax, then types). False on timeout.
   */
  async waitForDiagnostics(file: string, after: number, timeoutMs: number, settleMs = 250): Promise<boolean> {
    const uri = this.uri(file);
    if (this.pull) {
      // Pull model: ask for them (the server computes them for the text it has now).
      try {
        const r = await this.rpc.request<{kind?: string; items?: Diagnostic[]}>('textDocument/diagnostic', {textDocument: {uri}}, timeoutMs);
        const prev = this.diags.get(uri);
        this.diags.set(uri, {list: r?.kind === 'unchanged' ? (prev?.list ?? []) : (r?.items ?? []), n: (prev?.n ?? 0) + 1});
        return true;
      } catch {
        return false;
      }
    }
    if ((this.diags.get(uri)?.n ?? 0) <= after) {
      let timer: NodeJS.Timeout | undefined;
      const got = await Promise.race([
        new Promise<boolean>((resolve) => this.waiters.push({uri, after, resolve: () => resolve(true)})),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
      ]);
      clearTimeout(timer);
      if (!got) return false;
    }
    await new Promise((r) => setTimeout(r, settleMs));
    return true;
  }

  /**
   * After a change, wait for a push server to finish re-checking: until every file has a fresh
   * report, or reports stop arriving for `quietMs`, or nothing at all comes for `idleMs`. Servers
   * only republish files whose problems changed, so a missing report means "same as before".
   */
  async waitSettled(entries: {file: string; after: number}[], timeoutMs: number, idleMs = 1000, quietMs = 250): Promise<void> {
    const start = Date.now();
    for (;;) {
      const now = Date.now();
      if (entries.every((e) => this.publishCount(e.file) > e.after)) return void (await new Promise((r) => setTimeout(r, 100)));
      const heard = this.lastPublishAt > start;
      if (heard && now - this.lastPublishAt >= quietMs) return;
      if (!heard && now - start >= idleMs) return;
      if (now - start >= timeoutMs) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Stop the server: polite shutdown, then the whole process tree. */
  async shutdown(): Promise<void> {
    try {
      if (this.alive) {
        await this.rpc.request('shutdown', null, 2000).catch(() => undefined);
        this.rpc.notify('exit', null);
      }
    } finally {
      this.rpc.close();
      setTimeout(() => {
        if (this.proc.exitCode === null) killTree(this.proc.pid, 'SIGKILL');
      }, 1000).unref();
      killTree(this.proc.pid, 'SIGTERM');
    }
  }
}
