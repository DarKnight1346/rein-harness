import {spawn} from '../../util/platform.js';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFileSync} from 'node:fs';
import readline from 'node:readline';
import {usageStore} from '../../store/usage.js';
import {EventQueue} from '../../util/proc.js';
import {accountEnv} from '../env.js';
import type {Account, ChatEvent, ImageInput, OneShotOpts, ProviderSession, TokenCount} from '../types.js';
import {reportSideUsage} from '../usage.js';
import {classifyError, parseRateLimitEvent, parseResetTime} from './stream.js';

export const claudeBin = () => process.env.REIN_CLAUDE_BIN ?? 'claude';

type Opts = {
  account: Account;
  model: string;
  systemPrompt: string;
  resumeId?: string;
  /** false for one-shot calls (decider, compactor, usage ping) so they don't pollute history. */
  persist: boolean;
  /** Disable extended thinking (decider calls: ~4s → ~1s on haiku). */
  noThinking?: boolean;
  /** With resumeId: branch into a new session id instead of continuing the original (/btw). */
  fork?: boolean;
  /** `--effort` level (fixed for the process; a change reopens the session). */
  effort?: string;
  /** The CLI's server-side WebSearch only (one-shot search calls); every other built-in stays off. */
  webSearch?: boolean;
  /** Rein tools: MCP proxy server + its socket, resolved before spawning. */
  tools?: {socket: string; names: string[]; proxy: {command: string; args: string[]}};
};

/** Flags verified in M0: no built-in tools, no MCP (incl. claude.ai connectors), no settings/skills. */
export function claudeArgs(opts: Omit<Opts, 'account'>): string[] {
  // Rein's tools come from its own MCP server; built-in tools stay off (`--tools ""`).
  const mcp = opts.tools
    ? JSON.stringify({mcpServers: {rein: {command: opts.tools.proxy.command, args: opts.tools.proxy.args, env: {REIN_TOOL_SOCKET: opts.tools.socket}}}})
    : '{"mcpServers":{}}';
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--system-prompt', opts.systemPrompt,
    '--tools', opts.webSearch ? 'WebSearch' : '',
    '--strict-mcp-config', '--mcp-config', mcp,
    ...(opts.tools ? ['--allowedTools', opts.tools.names.map((n) => `mcp__rein__${n}`).join(',')] : []),
    ...(opts.webSearch ? ['--allowedTools', 'WebSearch'] : []),
    '--setting-sources', '',
    '--disable-slash-commands',
    '--model', opts.model,
    ...(opts.effort ? ['--effort', opts.effort] : []),
    ...(opts.resumeId ? ['--resume', opts.resumeId] : []),
    ...(opts.resumeId && opts.fork ? ['--fork-session'] : []),
    ...(opts.persist ? [] : ['--no-session-persistence']),
  ];
}

/**
 * One long-lived `claude -p` stream-json process = one native conversation.
 * Turns are sequential; model switches use the `set_model` control request (no restart).
 */
export class ClaudeSession implements ProviderSession {
  readonly provider = 'claude' as const;
  readonly accountId: string;
  model: string;
  private proc: ChildProcessWithoutNullStreams;
  private sessionId: string | undefined;
  private turn: {queue: EventQueue<ChatEvent>; interrupted: boolean; text: boolean; done: TokenCount; msg: TokenCount} | undefined;
  private controls = new Map<string, (ok: boolean, err?: string) => void>();
  private nextControl = 1;
  private exited = false;
  private stderr = '';

  get effort(): string | undefined {
    return this.opts.effort;
  }

  constructor(private readonly opts: Opts) {
    this.accountId = opts.account.id;
    this.model = opts.model;
    this.sessionId = opts.resumeId;
    this.proc = spawn(claudeBin(), claudeArgs(opts), {
      env: {
        ...accountEnv(opts.account),
        ...(opts.noThinking ? {MAX_THINKING_TOKENS: '0'} : {}),
        // Rein's shell tool can run for hours (user-configurable cap) plus time waiting for approval;
        // Rein enforces the real limit itself, so Claude's MCP timeout just needs to be out of the way.
        ...(opts.tools ? {MCP_TOOL_TIMEOUT: String(24 * 3600_000)} : {}),
        // Rein compacts the conversation itself (at /settings → Compaction, mid-turn included) and
        // keeps the agent going; Claude's own auto-compact would rewrite the history behind its back.
        ...(opts.tools ? {DISABLE_AUTO_COMPACT: '1'} : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.on('error', (err) => this.onExit(err.message));
    this.proc.on('close', (code) => this.onExit(`claude exited (${code})${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ''}`));
    this.proc.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    this.proc.stdin.on('error', () => {});
    readline.createInterface({input: this.proc.stdout}).on('line', (l) => this.onLine(l));
  }

  nativeId() {
    return this.sessionId;
  }

  send(text: string, images: ImageInput[] = []): AsyncIterable<ChatEvent> {
    const queue = new EventQueue<ChatEvent>();
    if (this.turn) {
      queue.push({type: 'error', kind: 'other', message: 'a turn is already running'});
      queue.end();
      return queue;
    }
    if (this.exited) {
      queue.push({type: 'error', kind: classifyError(this.stderr), message: this.stderr.trim().slice(-300) || 'claude is not running'});
      queue.end();
      return queue;
    }
    const zero = {input: 0, cached: 0, output: 0};
    this.turn = {queue, interrupted: false, text: false, done: {...zero}, msg: {...zero}};
    // Images go as base64 content blocks ahead of the text (the Messages API format).
    const content = images.length
      ? [...images.map((img) => ({type: 'image', source: {type: 'base64', media_type: img.mime, data: readFileSync(img.path).toString('base64')}})), {type: 'text', text}]
      : text;
    this.write({type: 'user', message: {role: 'user', content}});
    return queue;
  }

  interrupt(): void {
    if (!this.turn || this.turn.interrupted) return;
    this.turn.interrupted = true;
    void this.control({subtype: 'interrupt'}).catch(() => {});
  }

  async setModel(model: string): Promise<void> {
    if (model === this.model) return;
    await this.control({subtype: 'set_model', model});
    this.model = model;
  }

  close(): void {
    this.exited = true;
    this.proc.stdin.end();
    setTimeout(() => this.proc.kill('SIGTERM'), 2000).unref();
  }

  private control(request: object): Promise<void> {
    const id = `rein-${this.nextControl++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id);
        reject(new Error('control request timed out'));
      }, 15_000);
      this.controls.set(id, (ok, err) => {
        clearTimeout(timer);
        ok ? resolve() : reject(new Error(err ?? 'control request failed'));
      });
      this.write({type: 'control_request', request_id: id, request});
    });
  }

  private write(msg: object): void {
    if (!this.exited) this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onLine(line: string): void {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && ev.session_id) this.sessionId = ev.session_id;
        return;
      case 'stream_event': {
        const e = ev.event;
        // Token usage per API call within the turn (a tool-using turn makes several calls).
        if (this.turn && (e?.type === 'message_start' || e?.type === 'message_delta')) {
          const u = e.type === 'message_start' ? e.message?.usage : e.usage;
          if (u) {
            const t = this.turn;
            if (e.type === 'message_start') {
              t.done = {input: t.done.input + t.msg.input, cached: t.done.cached + t.msg.cached, output: t.done.output + t.msg.output};
              t.msg = {input: 0, cached: 0, output: 0};
            }
            const cached = u.cache_read_input_tokens ?? 0;
            if (u.input_tokens !== undefined) t.msg.input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached;
            if (u.cache_read_input_tokens !== undefined) t.msg.cached = cached;
            if (u.output_tokens !== undefined) t.msg.output = u.output_tokens;
            t.queue.push({type: 'tokens', call: {input: t.done.input + t.msg.input, cached: t.done.cached + t.msg.cached, output: t.done.output + t.msg.output}});
          }
        }
        // Only text deltas are reply text; thinking deltas are dropped.
        // A new text block after earlier text (e.g. after a tool call) starts a new paragraph.
        if (e?.type === 'content_block_start' && e.content_block?.type === 'text' && this.turn?.text) {
          this.turn.queue.push({type: 'text', delta: '\n\n'});
        }
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && this.turn) {
          this.turn.text = true;
          this.turn.queue.push({type: 'text', delta: e.delta.text});
        }
        return;
      }
      case 'rate_limit_event': {
        const usage = parseRateLimitEvent(ev);
        if (usage) {
          usageStore.set(this.accountId, usage);
          this.turn?.queue.push({type: 'usage', usage});
        }
        return;
      }
      case 'control_response': {
        const r = ev.response ?? {};
        const done = this.controls.get(r.request_id);
        if (done) {
          this.controls.delete(r.request_id);
          done(r.subtype === 'success', r.error);
        }
        return;
      }
      case 'result':
        return this.onResult(ev);
    }
  }

  private onResult(ev: any): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    if (ev.session_id) this.sessionId = ev.session_id;
    if (turn.interrupted) {
      // A requested interrupt ends with result/error_during_execution: that's success, not an error.
      turn.queue.push({type: 'done', interrupted: true});
    } else if (ev.is_error || ev.subtype !== 'success') {
      const message = String(ev.result ?? (ev.errors ?? []).join('; ') ?? ev.subtype ?? 'error');
      const kind = classifyError(message);
      const resetsAt = kind === 'limit' ? limitReset(this.accountId, message) : undefined;
      if (kind === 'limit') usageStore.coolDown(this.accountId, resetsAt ?? Date.now() + 15 * 60_000);
      turn.queue.push({type: 'error', kind, message, resetsAt});
    } else {
      if (!turn.text && typeof ev.result === 'string' && ev.result) turn.queue.push({type: 'text', delta: ev.result});
      const u = ev.usage ?? {};
      // `result.usage` sums every API call in the turn (a tool-using turn makes several), so it
      // overstates the context. The last call's input is what the context actually holds now.
      const input = turn.msg.input || (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      // modelUsage reports the model's real context window (e.g. sonnet 5.5 = 1M).
      const windows = Object.values<any>(ev.modelUsage ?? {}).map((m) => m?.contextWindow).filter((n): n is number => typeof n === 'number');
      turn.queue.push({type: 'done', interrupted: false, tokens: {input, output: u.output_tokens ?? 0}, contextWindow: windows.length ? Math.max(...windows) : undefined});
    }
    turn.queue.end();
  }

  private onExit(message: string): void {
    const wasClosed = this.exited;
    this.exited = true;
    for (const done of this.controls.values()) done(false, message);
    this.controls.clear();
    if (this.turn) {
      const {queue, interrupted} = this.turn;
      this.turn = undefined;
      if (interrupted) queue.push({type: 'done', interrupted: true});
      else if (!wasClosed) queue.push({type: 'error', kind: classifyError(message), message});
      else queue.push({type: 'done', interrupted: true});
      queue.end();
    }
  }
}

function limitReset(accountId: string, message: string): number | undefined {
  const snap = usageStore.get(accountId);
  const fromSnap = snap?.windows.filter((w) => w.usedPct >= 100 && w.resetsAt).map((w) => w.resetsAt!);
  if (fromSnap?.length) return Math.max(...fromSnap);
  return parseResetTime(message);
}

/** Run one prompt in a throwaway, non-persisted process and return the reply text. */
export async function claudeOneShot(opts: OneShotOpts): Promise<string> {
  const session = new ClaudeSession({account: opts.account, model: opts.model, systemPrompt: opts.system, persist: false, noThinking: opts.fast, webSearch: opts.webSearch});
  const timer = setTimeout(() => session.interrupt(), opts.timeoutMs ?? 60_000);
  let used: TokenCount | undefined;
  try {
    let text = '';
    for await (const ev of session.send(opts.prompt)) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'tokens') used = ev.call; // cumulative over the call's requests
      else if (ev.type === 'error') throw Object.assign(new Error(ev.message), {kind: ev.kind});
      else if (ev.type === 'done' && ev.interrupted) throw new Error('timed out');
    }
    return text;
  } finally {
    clearTimeout(timer);
    session.close();
    reportSideUsage({provider: 'claude', model: opts.model}, used); // spent even when it failed
  }
}
