import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import readline from 'node:readline';
import type {Snapshot} from './worker.js';

/**
 * The open chats of the web UI: one worker process each (worker.ts), in its project's folder.
 * Pages watch a chat over server-sent events: on connecting they get its snapshot, the events of
 * the turn in progress and any question waiting for an answer, then everything live. Several
 * devices can watch the same chat. A chat nobody has watched for a while is closed.
 */
export type WorkerCommand = (cwd: string) => {command: string; args: string[]};
export type Ask = {id: number; kind: string; payload: unknown};

const IDLE_MS = 30 * 60_000;
const BACKLOG = 4000;

export class Chat extends EventEmitter {
  readonly id = randomBytes(8).toString('hex');
  snapshot: Snapshot | undefined;
  busy = false;
  /** The turn's stand-in for "Thinking" (ui/phrases.ts). */
  phrase: string | undefined;
  /** Events since the last snapshot (the turn in progress), for a page that connects mid-turn. */
  backlog: Record<string, unknown>[] = [];
  asks = new Map<number, Ask>();
  watchers = 0;
  lastSeen = Date.now();
  error: string | undefined;
  readonly ready: Promise<void>;
  private proc: ChildProcessWithoutNullStreams;
  private stderr = '';

  constructor(readonly cwd: string, command: WorkerCommand, resume?: string) {
    super();
    const {command: cmd, args} = command(cwd);
    this.proc = spawn(cmd, args, {cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: {...process.env, REIN_WEB_WORKER: '1'}});
    this.proc.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.ready = new Promise((resolve, reject) => {
      this.once('ready', resolve);
      this.proc.once('error', reject);
      this.proc.once('exit', (code) => reject(new Error(`the chat stopped (${code})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)));
    });
    this.ready.catch((err) => (this.error = (err as Error).message));
    readline.createInterface({input: this.proc.stdout}).on('line', (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      this.onMessage(m);
    });
    this.proc.on('exit', () => this.emit('exit'));
    this.write({t: 'init', ...(resume ? {resume} : {})});
  }

  private onMessage(m: any): void {
    if (m.t === 'ready' || m.t === 'snapshot') {
      this.snapshot = m.snapshot;
      this.busy = !!m.snapshot.busy;
      if (!this.busy) this.backlog = [];
      if (m.t === 'ready') this.emit('ready');
      this.broadcast({type: 'snapshot', snapshot: m.snapshot});
    } else if (m.t === 'event') {
      // The first message names the chat right away (the snapshot's title comes after the turn).
      if (m.ev.type === 'user' && this.snapshot && !this.snapshot.messages.length) this.snapshot.title = String(m.ev.text).split('\n')[0]!.slice(0, 80);
      this.backlog.push(m.ev);
      if (this.backlog.length > BACKLOG) this.backlog.splice(0, this.backlog.length - BACKLOG);
      this.broadcast(m.ev);
    } else if (m.t === 'busy') {
      this.busy = m.busy;
      if (m.busy) this.backlog = [];
      if (m.phrase) this.phrase = m.phrase;
      this.broadcast({type: 'busy', busy: m.busy, ...(m.busy && this.phrase ? {phrase: this.phrase} : {})});
    } else if (m.t === 'ask') {
      const a: Ask = {id: m.id, kind: m.kind, payload: m.payload};
      this.asks.set(a.id, a);
      this.broadcast({type: 'ask', ...a});
    }
  }

  private broadcast(ev: Record<string, unknown>): void {
    this.emit('event', ev);
  }

  private write(m: object): void {
    if (!this.proc.killed) this.proc.stdin.write(JSON.stringify(m) + '\n');
  }

  send(text: string): void {
    this.write({t: 'send', text});
  }
  interrupt(): void {
    this.write({t: 'interrupt'});
  }
  answer(id: number, value: unknown): boolean {
    if (!this.asks.delete(id)) return false;
    this.write({t: 'answer', id, value});
    this.broadcast({type: 'answered', id});
    return true;
  }
  setModel(model: string): void {
    this.write({t: 'model', model});
  }
  setMode(mode: string): void {
    this.write({t: 'mode', mode});
  }
  compact(): void {
    this.write({t: 'compact'});
  }
  close(): void {
    this.proc.stdin.end();
    setTimeout(() => this.proc.kill(), 3000).unref();
  }
}

export class Chats {
  private chats = new Map<string, Chat>();
  private sweep: NodeJS.Timeout;
  constructor(private readonly command: WorkerCommand) {
    this.sweep = setInterval(() => {
      for (const c of this.chats.values()) if (!c.watchers && !c.busy && Date.now() - c.lastSeen > IDLE_MS) this.close(c.id);
    }, 60_000);
    this.sweep.unref();
  }

  /** Open a chat in `cwd` (new, or a saved conversation). An open one for the same conversation is reused. */
  open(cwd: string, resume?: string): Chat {
    if (resume) for (const c of this.chats.values()) if (c.snapshot?.session === resume || (c as any).resume === resume) return c;
    const c = new Chat(cwd, this.command, resume);
    (c as any).resume = resume;
    this.chats.set(c.id, c);
    c.on('exit', () => this.chats.delete(c.id));
    return c;
  }
  get(id: string): Chat | undefined {
    return this.chats.get(id);
  }
  list(): Chat[] {
    return [...this.chats.values()];
  }
  close(id: string): void {
    this.chats.get(id)?.close();
    this.chats.delete(id);
  }
  closeAll(): void {
    clearInterval(this.sweep);
    for (const id of [...this.chats.keys()]) this.close(id);
  }
}
