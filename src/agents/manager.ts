import {EventEmitter} from 'node:events';
import type {ModelRef, ProviderSession, TokenCount, ToolBinding} from '../providers/types.js';
import type {Origin} from '../tools/fs.js';
import type {DiffLine} from '../tools/diff.js';

export type SubagentMode = 'new' | 'fork';
export type SubagentStatus = 'starting' | 'running' | 'checking' | 'done' | 'failed' | 'cancelled';

/** What the subagent window shows, in order. */
export type SubagentEvent =
  | {kind: 'text'; text: string}
  | {kind: 'tool'; id: number; label: string; summary: string; ok?: boolean; result?: string; diff?: DiffLine[]}
  | {kind: 'check'; complete: boolean; note: string}
  | {kind: 'user'; text: string}
  | {kind: 'note'; text: string};

export type Subagent = {
  id: number;
  name: string;
  task: string;
  mode: SubagentMode;
  /** Requested model ('auto' resolved into `ref` once routed). */
  requested: string;
  ref?: ModelRef;
  modelLabel?: string;
  accountId?: string;
  background: boolean;
  status: SubagentStatus;
  startedAt: number;
  endedAt?: number;
  /** Final report (the last round's text). */
  output: string;
  rounds: number;
  events: SubagentEvent[];
  tokens: TokenCount;
  error?: string;
  /** The main agent has its report (foreground return, agent_result, or automatic delivery). */
  collected?: boolean;
  /** Input tokens of its latest request (≈ how full its context is). */
  lastInput?: number;
};

export type CompletionVerdict = {complete: boolean; note: string};

export type SubagentDeps = {
  limit(): number;
  /** Resolve the model + account for a new-session subagent (`auto` → router). */
  resolve(requested: string, task: string): Promise<{ref: ModelRef; accountId: string; label: string}>;
  /** Open the subagent's session: a fork of the parent's, or a fresh one. */
  open(agent: Subagent, tools: ToolBinding): Promise<{session: ProviderSession; ref: ModelRef; accountId: string; label: string}>;
  /** Tool binding for this subagent (origin-tagged calls; Claude gets its own socket). */
  bind(agent: Subagent): {binding: ToolBinding; close(): void};
  /** Decision model: has the subagent actually finished? */
  judge(agent: Subagent): Promise<CompletionVerdict>;
  /** Tool activity of this subagent (from the tool host). */
  onActivity(agentId: number, fn: (a: {phase: 'start' | 'end'; id: number; label: string; summary: string; ok?: boolean; result?: string; diff?: DiffLine[]}) => void): () => void;
  /** Called once when a subagent ends (fold tokens, persist the record). */
  finished(agent: Subagent): void;
  /** Stop the subagent's own foreground shells. */
  killShells(agentId: number): void;
};

export const MAX_CONTINUATIONS = 3;

const FORK_PREFIX = (name: string) => `<subagent name="${name}">
You are now a subagent forked from the main conversation (you keep its full history). The main agent
delegated the task below to you. Do it completely and autonomously with your tools — the user won't
answer questions here, and you can't spawn further subagents. Don't continue the main conversation's
other work. Finish with a concise report of what you did and found.
</subagent>

Task: `;

export const SUBAGENT_PROMPT = (name: string) => `# Subagent
You are "${name}", a subagent working for the main Rein agent. You received one task from it.
- Complete the task fully and autonomously with your tools; the user won't answer questions here.
- You can't spawn subagents.
- Finish with a concise report: what you did, what you found, anything left undone and why.`;

const CONTINUE_PROMPT =
  'A completion check found that the task is not finished yet. Re-read the task, do whatever is still missing, and then give your final report.';

/**
 * Subagents spawned by the main agent's `agent` tool: concurrency-limited, cancellable, each with
 * a completion check by the decision model. Emits `change` on any update.
 */
export class SubagentManager extends EventEmitter {
  private nextId = 1;
  private agents = new Map<number, Subagent>();
  private sessions = new Map<number, ProviderSession>();
  private done = new Map<number, Promise<Subagent>>();
  private cancelled = new Set<number>();
  /** Tool-binding cleanup per agent; sessions stay open after the task so the user can keep talking. */
  private closers = new Map<number, () => void>();
  private offs = new Map<number, () => void>();

  constructor(private readonly deps: SubagentDeps) {
    super();
  }

  list(): Subagent[] {
    return [...this.agents.values()];
  }

  get(id: number): Subagent | undefined {
    return this.agents.get(id);
  }

  running(opts: {background?: boolean} = {}): Subagent[] {
    return this.list().filter((a) => ['starting', 'running', 'checking'].includes(a.status) && (opts.background === undefined || a.background === opts.background));
  }

  /** Wait for a subagent to finish. */
  wait(id: number): Promise<Subagent> | undefined {
    return this.done.get(id);
  }

  spawn(args: {task: string; model: string; mode: SubagentMode; name?: string; background?: boolean}): {agent: Subagent; done: Promise<Subagent>} {
    const limit = this.deps.limit();
    if (this.running().length >= limit) {
      throw new Error(`subagent limit reached (${limit} running; the user's limit is ${limit}). Wait for one with agent_result {id, wait: true}, or do the work yourself.`);
    }
    const id = this.nextId++;
    const agent: Subagent = {
      id,
      name: (args.name?.trim() || `agent-${id}`).slice(0, 40),
      task: args.task,
      mode: args.mode,
      requested: args.model,
      background: !!args.background,
      status: 'starting',
      startedAt: Date.now(),
      output: '',
      rounds: 0,
      events: [],
      tokens: {input: 0, cached: 0, output: 0},
    };
    this.agents.set(id, agent);
    const done = this.run(agent);
    this.done.set(id, done);
    this.changed();
    return {agent, done};
  }

  /** True while a turn is in flight (task rounds, completion check, or a user message). */
  isActive(a: Subagent): boolean {
    return ['starting', 'running', 'checking'].includes(a.status);
  }

  /**
   * The user talks to a subagent directly (its view in the UI): one more turn on its session, no
   * completion check. Fails while it's busy or if its session is gone.
   */
  async message(id: number, text: string): Promise<void> {
    const agent = this.agents.get(id);
    const session = this.sessions.get(id);
    if (!agent) throw new Error(`no subagent #${id}`);
    if (this.isActive(agent)) throw new Error(`${agent.name} is busy — wait for it, or esc to stop it`);
    if (!session) throw new Error(`${agent.name}'s session has ended`);
    this.cancelled.delete(id);
    agent.events.push({kind: 'user', text});
    agent.status = 'running';
    agent.endedAt = undefined;
    this.changed();
    try {
      agent.output = (await this.turn(agent, session, text)).trim() || agent.output;
      agent.status = 'done';
    } catch (err) {
      agent.status = err instanceof Cancelled || this.cancelled.has(id) ? 'cancelled' : 'failed';
      if (agent.status === 'failed') agent.events.push({kind: 'note', text: `Failed: ${(err as Error).message}`});
    } finally {
      agent.endedAt = Date.now();
      if (agent.accountId && this.retiredAccounts.has(agent.accountId)) this.release(id);
      this.deps.finished(agent);
      this.changed();
    }
  }

  /** An account is being removed: close idle subagent sessions on it now, running ones when they finish. */
  releaseAccount(accountId: string): void {
    this.retiredAccounts.add(accountId);
    for (const a of this.agents.values()) if (a.accountId === accountId && !this.isActive(a)) this.release(a.id);
  }
  private retiredAccounts = new Set<string>();

  /** Close every subagent session (exit, /clear). */
  closeAll(): void {
    this.cancelAll();
    for (const id of [...this.sessions.keys()]) this.release(id);
    this.agents.clear();
    this.done.clear();
    this.changed();
  }

  private release(id: number): void {
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
    this.closers.get(id)?.();
    this.closers.delete(id);
    this.offs.get(id)?.();
    this.offs.delete(id);
  }

  cancel(id: number): boolean {
    const a = this.agents.get(id);
    if (!a || !['starting', 'running', 'checking'].includes(a.status)) return false;
    this.cancelled.add(id);
    this.sessions.get(id)?.interrupt();
    this.deps.killShells(id);
    return true;
  }

  /** Esc: foreground subagents stop with the main turn; Ctrl+C: everything. */
  cancelAll(opts: {foregroundOnly?: boolean} = {}): void {
    for (const a of this.running(opts.foregroundOnly ? {background: false} : {})) this.cancel(a.id);
  }

  private async run(agent: Subagent): Promise<Subagent> {
    const {binding, close} = this.deps.bind(agent);
    this.closers.set(agent.id, close);
    const offActivity = this.deps.onActivity(agent.id, (a) => {
      if (a.phase === 'start') agent.events.push({kind: 'tool', id: a.id, label: a.label, summary: a.summary});
      else {
        const ev = agent.events.find((e): e is Extract<SubagentEvent, {kind: 'tool'}> => e.kind === 'tool' && e.id === a.id);
        if (ev) Object.assign(ev, {ok: a.ok, result: a.result, diff: a.diff});
      }
      this.changed();
    });
    this.offs.set(agent.id, offActivity);
    let session: ProviderSession | undefined;
    try {
      const opened = await this.deps.open(agent, binding);
      session = opened.session;
      Object.assign(agent, {ref: opened.ref, accountId: opened.accountId, modelLabel: opened.label});
      this.sessions.set(agent.id, session);
      if (this.cancelled.has(agent.id)) throw new Cancelled();
      let prompt = agent.mode === 'fork' ? FORK_PREFIX(agent.name) + agent.task : agent.task;
      for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
        agent.status = 'running';
        agent.rounds = round + 1;
        this.changed();
        const text = await this.turn(agent, session, prompt);
        agent.output = text.trim();
        if (this.cancelled.has(agent.id)) throw new Cancelled();
        agent.status = 'checking';
        this.changed();
        const verdict = await this.deps.judge(agent).catch((err): CompletionVerdict => ({complete: true, note: `check failed (${(err as Error).message}); accepting`}));
        agent.events.push({kind: 'check', complete: verdict.complete, note: verdict.note});
        if (verdict.complete) break;
        if (round === MAX_CONTINUATIONS) {
          agent.events.push({kind: 'note', text: `Stopped after ${MAX_CONTINUATIONS} continuation rounds.`});
          break;
        }
        prompt = CONTINUE_PROMPT;
      }
      agent.status = 'done';
    } catch (err) {
      if (err instanceof Cancelled || this.cancelled.has(agent.id)) agent.status = 'cancelled';
      else {
        agent.status = 'failed';
        agent.error = (err as Error).message;
        agent.events.push({kind: 'note', text: `Failed: ${agent.error}`});
      }
    } finally {
      // Finished sessions stay open for follow-up messages from the user; others are released —
      // and so is any session on an account that's being removed.
      if (agent.status !== 'done' || (agent.accountId && this.retiredAccounts.has(agent.accountId))) this.release(agent.id);
      agent.endedAt = Date.now();
      this.deps.finished(agent);
      this.changed();
    }
    return agent;
  }

  /** One provider turn: stream text into the agent's events, collect tokens. */
  private async turn(agent: Subagent, session: ProviderSession, prompt: string): Promise<string> {
    let text = '';
    const base = {...agent.tokens};
    let seenInput = 0; // token events are cumulative over the turn's requests
    for await (const ev of session.send(prompt)) {
      if (ev.type === 'text') {
        text += ev.delta;
        const last = agent.events.at(-1);
        if (last?.kind === 'text') last.text += ev.delta;
        else agent.events.push({kind: 'text', text: ev.delta});
        this.changed();
      } else if (ev.type === 'tokens') {
        agent.tokens = {input: base.input + ev.call.input, cached: base.cached + ev.call.cached, output: base.output + ev.call.output};
        // Each jump in input is one request's full prompt: how full the context is right now.
        if (ev.call.input > seenInput) {
          agent.lastInput = ev.call.input - seenInput;
          seenInput = ev.call.input;
        }
      } else if (ev.type === 'error') {
        throw new Error(ev.message);
      } else if (ev.type === 'done') {
        if (ev.interrupted) throw new Cancelled();
        if (ev.tokens) agent.lastInput = ev.tokens.input;
      }
    }
    return text;
  }

  /** Show a line in a subagent's view (command feedback while the user looks at it; not sent to the model). */
  note(id: number, text: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.events.push({kind: 'note', text});
    this.changed();
  }

  private changed(): void {
    this.emit('change');
  }
}

class Cancelled extends Error {}

/** One-line status for lists and tool results. */
export function subagentStatusText(a: Subagent, now = Date.now()): string {
  const secs = Math.round(((a.endedAt ?? now) - a.startedAt) / 1000);
  const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const label = {starting: 'starting', running: 'running', checking: 'checking completion', done: 'done', failed: 'failed', cancelled: 'cancelled'}[a.status];
  return `${label} ${a.status === 'starting' || a.status === 'running' || a.status === 'checking' ? dur : `after ${dur}`}`;
}

export type {Origin};
