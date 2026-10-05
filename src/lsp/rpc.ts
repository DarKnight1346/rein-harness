import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';

/**
 * JSON-RPC 2.0 over a language server's stdin/stdout, with LSP's `Content-Length` framing. Messages
 * may arrive split across chunks or several per chunk; the buffer is parsed byte-wise (lengths are
 * in bytes, not characters).
 */
export class Rpc extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, {resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout}>();
  private closed = false;

  constructor(private readonly proc: ChildProcess) {
    super();
    proc.stdout!.on('data', (d: Buffer) => this.feed(d));
    proc.on('exit', () => this.close(new Error('the language server exited')));
    proc.stdin!.on('error', () => this.close(new Error('the language server closed its input')));
  }

  /** Parse every complete message in the buffer (exported shape for tests via `parseFrames`). */
  private feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    const {messages, rest} = parseFrames(this.buf);
    this.buf = rest;
    for (const m of messages) this.dispatch(m as Record<string, unknown>);
  }

  private dispatch(m: Record<string, unknown>): void {
    if (typeof m.id === 'number' && ('result' in m || 'error' in m)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(String((m.error as {message?: string}).message ?? 'language server error')));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method === 'string') {
      // A request from the server (workspace/configuration, window/workDoneProgress/create…): answer
      // so it doesn't wait; Rein needs none of them.
      if (m.id !== undefined) this.send({jsonrpc: '2.0', id: m.id, result: m.method === 'workspace/configuration' ? [] : null});
      else this.emit('notification', m.method, m.params);
    }
  }

  private send(msg: unknown): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the language server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {resolve: resolve as (v: unknown) => void, reject, timer});
      this.send({jsonrpc: '2.0', id, method, params});
    });
  }

  notify(method: string, params: unknown): void {
    this.send({jsonrpc: '2.0', method, params});
  }

  close(err = new Error('closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('close');
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** Split a buffer into complete LSP messages and the unparsed remainder. */
export function parseFrames(buf: Buffer): {messages: unknown[]; rest: Buffer} {
  const messages: unknown[] = [];
  let at = 0;
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n', at);
    if (headerEnd < 0) break;
    const header = buf.subarray(at, headerEnd).toString('ascii');
    const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
    if (!Number.isFinite(len)) {
      at = headerEnd + 4; // not a header we understand: skip it
      continue;
    }
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    try {
      messages.push(JSON.parse(buf.subarray(start, start + len).toString('utf8')));
    } catch {}
    at = start + len;
  }
  return {messages, rest: buf.subarray(at)};
}
