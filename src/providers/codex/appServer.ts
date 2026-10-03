import {spawn} from '../../util/platform.js';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import readline from 'node:readline';
import {accountEnv} from '../env.js';
import type {Account} from '../types.js';

const codexBin = () => process.env.REIN_CODEX_BIN ?? 'codex';

export type RpcError = {code: number; message: string; data?: unknown};
export type Notification = {method: string; params?: any};
/** Server→client request (approvals, user input, …). Return a result or throw an RpcError. */
export type ServerRequestHandler = (method: string, params: any) => Promise<unknown>;

export class RpcRequestError extends Error {
  constructor(readonly method: string, readonly error: RpcError) {
    super(`${method}: ${error.message}`);
  }
}

/**
 * JSON-RPC client for `codex app-server` (newline-delimited JSON over stdio), one process per account.
 */
export class AppServerClient {
  private nextId = 1;
  private pending = new Map<number, {method: string; resolve: (v: any) => void; reject: (e: Error) => void}>();
  private listeners = new Set<(n: Notification) => void>();
  private exited = false;
  stderr = '';

  private constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly onServerRequest: ServerRequestHandler,
  ) {
    readline.createInterface({input: proc.stdout}).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-8000);
    });
    proc.on('close', (code) => {
      this.exited = true;
      for (const p of this.pending.values()) {
        p.reject(new Error(`codex app-server exited (${code}) during ${p.method}`));
      }
      this.pending.clear();
    });
  }

  static async start(
    account: Account,
    opts: {args?: string[]; onServerRequest?: ServerRequestHandler; experimental?: boolean} = {},
  ): Promise<AppServerClient> {
    if (account.home) await mkdir(account.home, {recursive: true, mode: 0o700});
    const proc = spawn(codexBin(), ['app-server', ...(opts.args ?? [])], {
      env: accountEnv(account),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Default: decline anything the server asks for. Rein ships no Codex built-in tools.
    const handler = opts.onServerRequest ?? (async (method) => {
      throw {code: -32601, message: `rein does not handle ${method}`} satisfies RpcError;
    });
    const client = new AppServerClient(proc, handler);
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', reject);
    });
    await client.request('initialize', {
      clientInfo: {name: 'rein', title: 'Rein', version: '0.1.0'},
      // Experimental API: needed for client-side (dynamic) tools.
      ...(opts.experimental ? {capabilities: {experimentalApi: true}} : {}),
    });
    client.notify('initialized');
    return client;
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`codex app-server not running (${method})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {method, resolve, reject});
      this.write({id, method, params});
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({method, params});
  }

  onNotification(fn: (n: Notification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve with the first notification matching `method` (and `pred`). */
  waitFor(method: string, pred: (params: any) => boolean = () => true): Promise<any> {
    return new Promise((resolve) => {
      const off = this.onNotification((n) => {
        if (n.method === method && pred(n.params)) {
          off();
          resolve(n.params);
        }
      });
    });
  }

  close(): void {
    if (!this.exited) this.proc.kill('SIGTERM');
  }

  onExit(fn: () => void): void {
    if (this.exited) fn();
    else this.proc.once('close', fn);
  }

  private write(msg: object): void {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise
    }
    if (msg.method && msg.id !== undefined) {
      // Server→client request.
      this.onServerRequest(msg.method, msg.params).then(
        (result) => this.write({id: msg.id, result: result ?? {}}),
        (err: RpcError | Error) =>
          this.write({id: msg.id, error: 'code' in err ? err : {code: -32603, message: String(err.message)}}),
      );
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcRequestError(p.method, msg.error));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of this.listeners) fn(msg);
    }
  }
}
