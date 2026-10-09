import {adapters} from '../providers/index.js';
import type {Account, ChatEvent, ImageInput, ModelRef, ProviderSession, TokenCount, ToolBinding} from '../providers/types.js';
import type {ToolActivity} from '../tools/host.js';
import {EventQueue} from '../util/proc.js';
import {refKey} from '../providers/types.js';
import {BUSY_PENALTY, catalog, toRef} from '../router/catalog.js';
import {activeExperiments, type Config} from '../store/config.js';
import {DANGER_HEADROOM, headroom, usageStore} from '../store/usage.js';
import {compactableCount, compactTranscript, type CompactReason, type CompactResult, type LiveSummarizer} from './compactor.js';
import {systemPrompt} from './prompt.js';
import {buildCarry, carryStart, estimateTokens, newTranscript, recordProgress, resultTokens, saveTranscript, scratchDir, truncateTranscript, type Message, type Transcript} from './transcript.js';
import {CARRY_TOOL_BUDGET, carriedTools, selectCarriedTools, type CarrySelector} from './carry.js';

export type Route = {ref: ModelRef; reason: 'fixed' | 'auto' | 'sticky' | 'default' | 'failover' | 'escalated'; confidence?: number};

export type EngineEvent =
  | {type: 'route'; route: Route; account: Account; effort?: string}
  | {type: 'tool'; activity: ToolActivity}
  | {type: 'tokens'; call: TokenCount}
  | {type: 'compact'; phase: 'start'; reason: CompactReason; messages: number}
  | {type: 'compact'; phase: 'end'; reason: CompactReason; result: CompactResult}
  | {type: 'text'; delta: string}
  | {type: 'notice'; text: string}
  /** Every account is at its limit: waiting until `until` (ms), then continuing. */
  | {type: 'waiting'; until: number}
  | {type: 'done'; interrupted: boolean}
  | {type: 'error'; message: string};

export type EngineDeps = {
  config: () => Config;
  /** Pick the model for this message (fixed or auto). */
  route: (text: string, t: Transcript, current: ModelRef | undefined) => Promise<Route>;
  /** Pick a replacement model when every account for `failed` is unavailable. */
  alternative: (text: string, t: Transcript, failed: ModelRef, exclude: ReadonlySet<string>) => Promise<ModelRef | undefined>;
  /** Summarize older messages into `t.summary` (M6). */
  compact: (t: Transcript, reason: CompactReason, opts?: {keepRecent?: number; model?: ModelRef; live?: LiveSummarizer}) => Promise<CompactResult>;
  /** Rein's tools for chat sessions, plus their activity feed (tool lines in the transcript). */
  tools?: {binding: ToolBinding; forkBinding?: ToolBinding; onActivity(fn: (a: ToolActivity) => void): () => void};
  /** Picks which tool results a new session needs when the conversation moves (compaction model). */
  selectCarry?: CarrySelector;
  /** Another conversation is now active (/clear, /resume): drop per-conversation state elsewhere. */
  onConversationChange?: () => void;
  /** UserPromptSubmit / SessionStart hooks: block the message, or add context to it. */
  beforePrompt?: (text: string) => Promise<{block?: string; context?: string}>;
  /** Auto effort: the decision model picks a level for this message from `levels`. */
  pickEffort?: (text: string, levels: string[]) => Promise<string | undefined>;
  /** A spending cap reached (budget): the message to show; the turn then stops. */
  overBudget?: () => string | undefined;
  /** A turn finished (telemetry): its model, timing and what it spent. */
  onTurnEnd?: (turn: {ref: ModelRef; startedAt: number; interrupted: boolean; tokens: TokenCount}) => void;
};

/** Context carried into a fresh native session before compaction kicks in. */
const CARRY_BUDGET_TOKENS = 24_000;
/**
 * How long a provider keeps a conversation's prompt cache after a request — measured through
 * Rein's own sessions (PLAN.md §22): Claude writes `ephemeral_1h` and served 99% from cache after
 * 58 min, 0% after 65; Codex still served 94% after 61 min. One hour for both.
 */
/** Auto effort considers low only for messages up to this size (~2,000 characters). */
const SIMPLE_MAX_TOKENS = 500;
const CACHE_WARM_MS: Record<string, number> = {claude: 60 * 60_000, codex: 60 * 60_000};
/** A cold switch needs the other account to be at least this much better (no flip-flopping). */
const BALANCE_MARGIN = 15;
const MAX_ATTEMPTS = 5;
/** Compactions inside one turn before Rein stops compacting it: a backstop (each needs progress first, see `laterRequest`). */
const MAX_MIDTURN_COMPACTIONS = 20;
/** price-break: compact at this share of the model's price break (headroom for one large tool result). */
const PRICE_BREAK_MARGIN = 0.8;
/** context-cap: every request re-reads the whole conversation, so past this size it costs more than a compaction. */
const CONTEXT_CAP = 200_000;
/** Sent after a mid-turn compaction so the agent picks the task back up instead of ending its turn. */
/** Messages Rein sends on its own to carry on the user's request (not a new request). */
const REIN_FOLLOW_UP = /^<(context_compacted|code_check|stop_hook)>/;
const CONTINUE_AFTER_COMPACTION = `<context_compacted>
The conversation was compacted in the middle of your work because the context window was filling up. The summary above covers everything so far, including your tool calls and where you stopped. Continue the task from exactly where you left off: don't start over, don't repeat finished steps, and don't stop to ask the user unless you genuinely need their input.
</context_compacted>`;

/**
 * Owns the conversation. Rein's transcript is the source of truth; native sessions are caches
 * reused while provider+account stay the same.
 */
/** Conversation totals plus one call's (or subagent's) tokens; `usd` stays unset until something has a price. */
function plus(base: {uncached: number; cached: number; output: number; usd?: number}, t: TokenCount): {uncached: number; cached: number; output: number; usd?: number} {
  const usd = base.usd === undefined && t.usd === undefined ? undefined : (base.usd ?? 0) + (t.usd ?? 0);
  return {uncached: base.uncached + t.input - t.cached, cached: base.cached + t.cached, output: base.output + t.output, ...(usd === undefined ? {} : {usd})};
}

export class Engine {
  transcript: Transcript;
  private active: {session: ProviderSession; key: string; ref: ModelRef} | undefined;
  /** A number per native session object: a new one (compaction, failover, a model switch) means the model lost what it saw. */
  private serials = new WeakMap<ProviderSession, number>();
  private nextSerial = 1;

  /** The model the conversation is on right now. */
  currentRef(): ModelRef | undefined {
    return this.active?.ref;
  }

  /** Which model context tool results go to now: changes whenever earlier results may be gone. */
  contextId(): string | undefined {
    const a = this.active;
    if (!a) return undefined;
    if (!this.serials.has(a.session)) this.serials.set(a.session, this.nextSerial++);
    return `${a.key}#${this.serials.get(a.session)}#${this.transcript.summary?.coversUpTo ?? 0}`;
  }
  private running: ProviderSession | undefined;
  private interruptRequested = false;
  /** Tokens of the call in flight (live), folded into `transcript.tokens` when it ends. */
  callTokens: TokenCount | undefined;

  /** Conversation totals including the call in flight. */
  get sessionTokens(): {uncached: number; cached: number; output: number; usd?: number} {
    const base = this.transcript.tokens ?? {uncached: 0, cached: 0, output: 0};
    const c = this.callTokens;
    return c ? plus(base, c) : base;
  }

  private commitCallTokens(): void {
    if (!this.callTokens) return;
    this.transcript.tokens = this.sessionTokens;
    this.callTokens = undefined;
  }

  /** Tokens the provider reported for the last completed request (for /context). */
  lastUsage: {ref: ModelRef; input: number; output: number; at: number} | undefined;
  /** The turn in progress: reply so far and finished tool calls (saved to the transcript at its end). */
  inFlight: {reply: string; tools: NonNullable<Message['tools']>} | undefined;
  /** When each account last served this conversation (its prompt cache is warm for a few minutes). */
  private readonly lastUsed = new Map<string, number>();
  /** Compaction replaced the history since the last turn: no cache left to protect. */
  private cacheBroken = false;
  /** Account that served the last turn (survives compaction, which drops the native sessions). */
  private lastAccountId: string | undefined;

  /**
   * An account is being removed: drop its session now if idle, otherwise right after the running
   * turn (the reply isn't cut off). The next turn picks another account and carries the context.
   */
  releaseAccount(accountId: string): void {
    if (this.active?.session.accountId !== accountId) return;
    if (this.running) this.releaseAfterTurn = accountId;
    else this.closeActive();
  }
  private releaseAfterTurn: string | undefined;

  constructor(private readonly deps: EngineDeps, transcript?: Transcript) {
    this.transcript = transcript ?? newTranscript();
  }

  get current(): {ref: ModelRef; accountId: string} | undefined {
    return this.active ? {ref: this.active.ref, accountId: this.active.session.accountId} : undefined;
  }

  /**
   * /btw: branch the live native session (full history, tool results included) and run `prompt` on
   * the branch while the main turn keeps going. Throws if there's no native session to fork yet.
   */
  async *fork(prompt: string): AsyncGenerator<ChatEvent> {
    const branch = await this.openFork(this.deps.tools?.forkBinding);
    try {
      yield* branch.send(prompt);
    } finally {
      branch.close();
    }
  }

  /** A branch of the live native session (same model/account, full history) with the given tools. */
  async openFork(tools: ToolBinding | undefined): Promise<ProviderSession> {
    const active = this.active;
    const nativeId = active?.session.nativeId();
    if (!active || !nativeId) throw new Error('nothing to fork yet (no live session); use mode "new"');
    const account = catalog.account(active.session.accountId);
    if (!account) throw new Error('account not found');
    return adapters[active.ref.provider].fork({
      account,
      model: active.ref.model,
      systemPrompt: await systemPrompt({tools: !!this.deps.tools, scratch: this.scratch, provider: active.ref.provider}),
      nativeId,
      tools,
    });
  }

  /** Add tokens spent outside the main turn (subagents) to the conversation totals. */
  addTokens(t: TokenCount): void {
    this.transcript.tokens = plus(this.transcript.tokens ?? {uncached: 0, cached: 0, output: 0}, t);
  }

  get isBusy(): boolean {
    return !!this.running;
  }

  interrupt(): void {
    this.interruptRequested = true;
    this.running?.interrupt();
    this.wakeWait?.();
  }

  /** `/compact`: summarize now; the next turn starts a fresh native session from the summary. */
  async compactNow(focus?: string): Promise<CompactResult> {
    const res = await compactTranscript(this.transcript, this.deps.config(), {keepRecent: 2, focus, model: this.active?.ref, live: this.liveSummarizer()});
    if (!('skipped' in res)) {
      this.closeActive();
      this.cacheBroken = true;
    }
    return res;
  }

  /**
   * /rewind: end the conversation just before message `index` (a user message). Native sessions
   * no longer match the history, so the next turn starts fresh and carries what's left.
   */
  async rewind(index: number): Promise<void> {
    const t = this.transcript;
    this.closeActive();
    if (t.summary && t.summary.coversUpTo > index) delete t.summary;
    t.native = {};
    this.lastUsage = undefined;
    this.inFlight = undefined;
    this.cacheBroken = true;
    await truncateTranscript(t, index);
  }

  /** Switch to a saved conversation (`rein --continue` picker / `/resume`). */
  load(t: Transcript): void {
    this.closeActive();
    this.transcript = t;
    this.lastUsage = undefined;
    this.inFlight = undefined;
    this.callTokens = undefined;
    this.forgetAccounts();
  }

  /**
   * Tool definitions changed (e.g. the advisor was switched on): drop the live native session; the
   * next turn resumes it (same history) with the new tool list.
   */
  /**
   * Wait until an account for `ref` can be used again: the reset time, or sooner if usage
   * refreshes show one free (checked every minute). False if interrupted.
   */
  private async waitForAccount(ref: ModelRef, until: number): Promise<boolean> {
    const cfg = this.deps.config();
    while (!this.interruptRequested) {
      if (this.pickAccount(ref, new Set(), cfg, this.transcript.messages.length - 1)?.account) return true;
      const left = until + limitWait.marginMs - Date.now(); // a little after the reset, so it has happened
      if (left <= 0) return true;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(limitWait.pollMs, left));
        this.wakeWait = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wakeWait = undefined;
    }
    return false;
  }
  private wakeWait: (() => void) | undefined;

  refreshTools(): void {
    if (!this.running) this.closeActive();
  }

  /** This conversation's scratchpad directory. */
  get scratch(): string {
    return scratchDir(this.transcript.id);
  }

  /** Start a new conversation (keeps nothing). */
  reset(): void {
    this.closeActive();
    this.transcript = newTranscript();
    this.lastUsage = undefined;
    this.inFlight = undefined;
    this.forgetAccounts();
  }

  shutdown(): void {
    this.closeActive();
  }

  async *send(typed: string, attached: ImageInput[] = []): AsyncGenerator<EngineEvent> {
    const t = this.transcript;
    const startedAt = Date.now();
    const before = this.sessionTokens;
    const cfg = this.deps.config();
    let text = typed;
    const hook = await this.deps.beforePrompt?.(text).catch(() => undefined);
    if (hook?.block) {
      yield {type: 'error', message: `Blocked by a UserPromptSubmit hook: ${hook.block}`};
      return;
    }
    if (hook?.context) text = `${text}\n\n<hook_context>\n${hook.context}\n</hook_context>`;
    // The conversation (or the goal) is already at its cap: don't start another request.
    const over = this.deps.overBudget?.();
    if (over) {
      yield {type: 'error', message: `${over} Raise the budget (/settings budget) or start a new conversation.`};
      return;
    }
    let images = attached;
    t.messages.push({role: 'user', text, at: Date.now(), ...(images.length ? {images} : {})});
    void saveTranscript(t); // on disk before the turn starts, so a crash mid-turn keeps the request
    let userIndex = t.messages.length - 1;
    this.interruptRequested = false;

    let route: Route;
    try {
      route = await this.deps.route(text, t, this.active?.ref);
    } catch (err) {
      yield {type: 'error', message: `routing failed: ${(err as Error).message}`};
      return;
    }

    const excluded = new Set<string>();
    let compacted = false;
    let midTurnCompactions = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this.interruptRequested) {
        yield {type: 'done', interrupted: true};
        return;
      }
      const picked = this.pickAccount(route.ref, excluded, cfg, userIndex);
      const account = picked?.account;
      if (picked?.note) yield {type: 'notice', text: picked.note};
      if (!account) {
        const alt = await this.deps.alternative(text, t, route.ref, excluded).catch(() => undefined);
        if (!alt || refKey(alt) === refKey(route.ref)) {
          // Every account is at its limit: wait for the earliest reset and carry on (Esc stops it).
          const until = earliestReset(route.ref);
          if (until && cfg.waitForLimits !== false && until - Date.now() <= limitWait.maxMs) {
            yield {type: 'notice', text: `${noAccountMessage(route.ref)} Waiting, then continuing (Esc stops).`};
            yield {type: 'waiting', until};
            const ready = await this.waitForAccount(route.ref, until);
            if (this.interruptRequested || !ready) {
              yield {type: 'done', interrupted: true};
              return;
            }
            yield {type: 'notice', text: `Limit reset — continuing with ${label(route.ref)}.`};
            excluded.clear();
            attempt--; // the wait isn't an attempt
            continue;
          }
          yield {type: 'error', message: noAccountMessage(route.ref)};
          return;
        }
        yield {type: 'notice', text: `No ${label(route.ref)} account available — switching to ${label(alt)}`};
        route = {ref: alt, reason: 'failover'};
        continue;
      }

      let session: ProviderSession;
      let prompt: string;
      let carried: string | undefined;
      try {
        const effort = await this.effortFor(route.ref, account, text);
        ({session, prompt, carried} = await this.prepare(route.ref, account, userIndex, effort));
      } catch (err) {
        catalog.authFailed.add(account.id);
        excluded.add(account.id);
        yield {type: 'notice', text: `${account.email ?? account.id}: ${(err as Error).message}`};
        continue;
      }
      if (estimateTokens(prompt) > CARRY_BUDGET_TOKENS + estimateTokens(text) && !compacted) {
        compacted = true;
        yield* this.compactWithEvents('handoff');
        ({prompt, carried} = await this.prepare(route.ref, account, userIndex, this.active?.session.effort));
      }
      if (carried) yield {type: 'notice', text: carried};

      yield {type: 'route', route, account, effort: session.effort};
      let reply = '';
      let savedText = 0; // reply text already in a progress record
      const replyTools: NonNullable<Message['tools']> = [];
      const fullResults: string[] = []; // unclipped, for the continuation after a mid-turn compaction
      let failure: {kind: string; message: string; resetsAt?: number} | undefined;
      this.running = session;
      this.inFlight = {reply: '', tools: replyTools};
      let seenInput = 0; // token events are cumulative over the turn's requests
      // Mid-turn compaction: once a request's prompt reaches the auto-compact threshold, stop the
      // turn between steps (never while a tool runs), compact, and carry on in a fresh session.
      const compactAt = this.autoCompactLimit(route.ref);
      let toolsRunning = 0;
      let compactDue = false;
      let compacting = false; // interrupt sent for a mid-turn compaction
      let continued = false; // compacted mid-turn; the continuation goes out next
      const stopForCompaction = () => {
        if (compacting || toolsRunning > 0 || this.interruptRequested) return;
        compacting = true;
        session.interrupt();
      };
      for await (const ev of this.withToolActivity(session.send(prompt, images))) {
        if (ev.type === 'tool') {
          const a = ev.activity;
          if (a.origin) continue; // a subagent's tool call: shown in its own view, not here
          if (a.phase === 'start') toolsRunning++;
          else {
            toolsRunning = Math.max(0, toolsRunning - 1);
            replyTools.push({label: a.label, summary: a.summary, ok: a.ok, result: clipResult(a.result), size: a.result.length, diff: a.diff});
            fullResults.push(a.result);
            // Crash safety: each finished tool call (and the text before it) goes to the log now.
            void recordProgress(t, t.messages.length, {tool: replyTools.at(-1), text: reply.slice(savedText), model: route.ref, accountId: account.id});
            savedText = reply.length;
          }
          yield ev;
          if (compactDue) stopForCompaction();
          continue;
        }
        if (ev.type === 'tokens') {
          this.callTokens = ev.call;
          // A spending cap (budget) reached: say so and stop the turn.
          const over = this.interruptRequested ? undefined : this.deps.overBudget?.();
          if (over) {
            yield {type: 'notice', text: over};
            this.interrupt();
          }
          // Each jump in input is one request's full prompt: how full the context is right now.
          if (ev.call.input > seenInput) {
            // Not on a segment's first request: nothing has happened yet that a compaction would fold away.
            const laterRequest = seenInput > 0;
            this.lastUsage = {ref: route.ref, input: ev.call.input - seenInput, output: 0, at: Date.now()};
            seenInput = ev.call.input;
            if (laterRequest && compactAt && this.lastUsage.input >= compactAt && midTurnCompactions < MAX_MIDTURN_COMPACTIONS) {
              compactDue = true;
              stopForCompaction();
            }
          }
          yield ev;
          continue;
        }
        if (ev.type === 'text') {
          reply += ev.delta;
          if (this.inFlight) this.inFlight.reply = reply;
          yield {type: 'text', delta: ev.delta};
        } else if (ev.type === 'done' && ev.interrupted && compacting && !this.interruptRequested) {
          // Stopped for a mid-turn compaction (not by the user): save the work so far, compact,
          // and send the continuation as a fresh request.
          this.running = undefined;
          this.inFlight = undefined;
          this.commitCallTokens();
          this.lastUsed.set(account.id, Date.now());
          this.lastAccountId = account.id;
          midTurnCompactions++;
          userIndex = yield* this.compactAndContinue(route.ref, account, reply, replyTools, fullResults, 'midturn');
          text = CONTINUE_AFTER_COMPACTION;
          images = [];
          continued = true;
          break;
        } else if (ev.type === 'done') {
          this.running = undefined;
          this.inFlight = undefined;
          this.commitCallTokens();
          this.lastUsed.set(account.id, Date.now());
          if (this.releaseAfterTurn === account.id) {
            this.releaseAfterTurn = undefined;
            this.closeActive();
          }
          this.lastAccountId = account.id;
          this.cacheBroken = false;
          t.messages.push({
            role: 'assistant',
            text: reply,
            at: Date.now(),
            model: route.ref,
            accountId: account.id,
            interrupted: ev.interrupted || undefined,
            tools: replyTools.length ? replyTools : undefined,
          });
          this.markCovered(account, session, t.messages.length);
          if (ev.tokens) this.lastUsage = {ref: route.ref, input: ev.tokens.input, output: ev.tokens.output, at: Date.now()};
          if (ev.contextWindow) catalog.learnContextWindow(route.ref, ev.contextWindow);
          await saveTranscript(t).catch(() => {});
          const now = this.sessionTokens;
          const usd = now.usd === undefined ? undefined : now.usd - (before.usd ?? 0);
          this.deps.onTurnEnd?.({ref: route.ref, startedAt, interrupted: ev.interrupted, tokens: {input: now.uncached - before.uncached + now.cached - before.cached, cached: now.cached - before.cached, output: now.output - before.output, ...(usd === undefined ? {} : {usd})}});
          yield {type: 'done', interrupted: ev.interrupted};
          yield* this.contextWarning(route.ref, ev.tokens?.input);
          yield* this.maybeAutoCompact(route.ref, ev.tokens?.input);
          return;
        } else if (ev.type === 'error') {
          failure = ev;
        }
      }
      if (continued) {
        attempt = -1; // a fresh request: failover attempts start over
        continue;
      }
      this.running = undefined;
      this.inFlight = undefined;
      this.commitCallTokens();
      if (!failure) failure = {kind: 'other', message: 'turn ended without a result'};

      if (failure.kind === 'limit' || failure.kind === 'auth' || failure.kind === 'overloaded') {
        if (failure.kind === 'auth') catalog.authFailed.add(account.id);
        // Adapters usually record this already; make sure the pool skips the account until reset.
        if (failure.kind === 'limit') usageStore.coolDown(account.id, failure.resetsAt ?? Date.now() + 15 * 60_000);
        excluded.add(account.id);
        this.closeActive();
        const why = failure.kind === 'limit' ? `hit its limit${failure.resetsAt ? ` (resets ${clock(failure.resetsAt)})` : ''}` : failure.kind === 'auth' ? 'needs re-login (/login)' : 'is overloaded';
        yield {type: 'notice', text: `${account.email ?? account.id} ${why}${reply ? ' — retrying' : ''}`};
        if (reply) yield {type: 'notice', text: '(partial reply discarded)'};
        continue;
      }
      if (failure.kind === 'context' && (reply || replyTools.length) && midTurnCompactions < MAX_MIDTURN_COMPACTIONS) {
        // The context overflowed mid-task: keep what the agent did and let it carry on, instead
        // of re-sending the request and losing the work.
        midTurnCompactions++;
        userIndex = yield* this.compactAndContinue(route.ref, account, reply, replyTools, fullResults, 'context');
        text = CONTINUE_AFTER_COMPACTION;
        images = [];
        attempt = -1;
        continue;
      }
      if (failure.kind === 'context' && !compacted) {
        compacted = true;
        yield* this.compactWithEvents('context');
        this.closeActive();
        continue;
      }
      await saveTranscript(t).catch(() => {});
      yield {type: 'error', message: failure.message};
      return;
    }
    yield {type: 'error', message: 'gave up after several failovers'};
  }

  /** Interleave tool activity (from the tool host) with the provider's stream, in arrival order. */
  private withToolActivity(stream: AsyncIterable<ChatEvent>): AsyncIterable<ChatEvent | {type: 'tool'; activity: ToolActivity}> {
    const tools = this.deps.tools;
    if (!tools) return stream;
    const q = new EventQueue<ChatEvent | {type: 'tool'; activity: ToolActivity}>();
    const off = tools.onActivity((activity) => {
      if (!activity.origin) q.push({type: 'tool', activity});
    });
    void (async () => {
      try {
        for await (const ev of stream) q.push(ev);
      } finally {
        off();
        q.end();
      }
    })();
    return q;
  }

  /**
   * Which account serves this turn. Healthy accounts come best-first (catalog.score: usage weighted
   * by time to reset, minus load). A new conversation starts on the best one. An active one
   * ("balanced") only moves when its cache can't be saved anyway or the account can't continue:
   * 1. the account is out of usage — rejected (unhealthy) or within DANGER_HEADROOM of a limit,
   *    so it moves before the rejection;
   * 2. the conversation was just compacted (the cache is gone);
   * 3. the prompt cache expired (idle ≥ the provider's CACHE_WARM_MS).
   * In cases 2–3 it moves only to a clearly better account (≥ BALANCE_MARGIN) and never if
   * carrying the history over would itself force a compaction.
   * "sticky" (the old behavior) stays until the account is unhealthy.
   */
  private pickAccount(ref: ModelRef, excluded: ReadonlySet<string>, cfg: Config, userIndex: number): {account?: Account; note?: string} | undefined {
    const healthy = catalog.healthyAccounts(ref, cfg.maxUsedPct, excluded);
    const best = healthy[0];
    if (!best) return undefined;
    // The account this conversation is on: the live session, else the one it last used.
    const currentId = this.active?.session.accountId ?? this.lastAccountId ?? this.lastAccount(ref.provider);
    const current = healthy.find((a) => a.id === currentId);
    if (!current) {
      // The conversation's account was removed: continue on the best one, context carried over.
      const removed = currentId && (catalog.retired.has(currentId) || !catalog.account(currentId));
      return {account: best, note: removed ? `Continuing on ${best.email ?? best.id} (the previous account was removed)` : undefined};
    }
    if (best.id === current.id || (cfg.loadBalancing ?? 'balanced') === 'sticky') return {account: current};
    const name = (a: Account) => a.email ?? a.id;
    if (headroom(usageStore.get(current.id)) < DANGER_HEADROOM) {
      return {account: best, note: `Load balancing: ${name(current)} is near its limit — switching to ${name(best)} before it's rejected`};
    }
    const lastUsed = this.lastUsed.get(current.id) ?? 0;
    const cacheWarm = !this.cacheBroken && Date.now() - lastUsed < (CACHE_WARM_MS[ref.provider] ?? 5 * 60_000);
    if (cacheWarm) return {account: current};
    // This conversation's own live session shouldn't count against the account it's on.
    const currentScore = catalog.score(current.id) + (this.active?.session.accountId === current.id ? BUSY_PENALTY : 0);
    const gain = catalog.score(best.id) - currentScore;
    if (gain < BALANCE_MARGIN) return {account: current};
    const covers = this.transcript.native[`${ref.provider}:${best.id}`]?.coversUpTo ?? 0;
    if (buildCarry(this.transcript, covers, userIndex, CARRY_BUDGET_TOKENS).overBudget) return {account: current};
    return {account: best, note: `Load balancing: switching to ${name(best)} (${this.cacheBroken ? 'after compaction' : 'cache was cold'}; balance score ${Math.round(catalog.score(best.id))} vs ${Math.round(currentScore)})`};
  }

  /** A different conversation: no account history or warm cache carries over. */
  private forgetAccounts(): void {
    this.deps.onConversationChange?.();
    this.lastUsed.clear();
    this.lastAccountId = undefined;
    this.cacheBroken = false;
  }

  /**
   * Effort for this turn. A fixed level (clamped to what the model supports) or the model default;
   * 'auto' asks the decision model — but only when the prompt cache is cold anyway, since changing
   * effort mid-conversation invalidates it. A warm session keeps its effort.
   */
  private async effortFor(ref: ModelRef, account: Account, text: string): Promise<string | undefined> {
    const levels = catalog.get(ref)?.efforts;
    if (!levels?.length) return undefined;
    const pref = this.deps.config().chatEffort ?? 'auto';
    if (pref === 'default') return undefined;
    if (pref !== 'auto') return clampEffort(pref, levels);
    const key = `${ref.provider}:${account.id}`;
    const warm = this.active?.key === key && !this.cacheBroken && Date.now() - (this.lastUsed.get(account.id) ?? 0) < (CACHE_WARM_MS[ref.provider] ?? 5 * 60_000);
    if (warm) return this.active!.session.effort;
    // Rein's own follow-ups (the continuation after a compaction, the code check, Stop hooks,
    // keep-going) are short but belong to the user's request: they keep its effort. Judged on their
    // own they read as "simple", and a long task carried on at low.
    if (REIN_FOLLOW_UP.test(text)) return this.requestEffort;
    // Auto only ever lowers effort: low for a simple message, else the model's own default (no flag).
    // Raising it on hard-looking requests (high, xhigh) doubled output and time on hard benchmark tasks
    // without solving more of them than the model's default did.
    // A long message is a spec, never a quick one: asked anyway, the decision model sometimes saw a
    // 15K-character feature spec as "mechanical" and ran it on low.
    if (!levels.includes('low') || estimateTokens(text) > SIMPLE_MAX_TOKENS) return (this.requestEffort = undefined);
    const picked = await this.deps.pickEffort?.(text, ['low', 'medium']).catch(() => undefined);
    return (this.requestEffort = picked === 'low' ? 'low' : undefined);
  }

  /** Auto effort chosen for the user's current request, which Rein's follow-ups to it keep. */
  private requestEffort: string | undefined;

  /** Account of the native session this conversation used most recently for a provider. */
  private lastAccount(provider: string): string | undefined {
    return Object.values(this.transcript.native)
      .filter((n) => n.provider === provider)
      .sort((a, b) => (b.coversUpTo ?? 0) - (a.coversUpTo ?? 0))[0]?.accountId;
  }

  /** Reuse or open the native session for (provider, account) and build the prompt with carry. */
  private async prepare(ref: ModelRef, account: Account, userIndex: number, effort?: string): Promise<{session: ProviderSession; prompt: string; carried?: string}> {
    const t = this.transcript;
    const key = `${ref.provider}:${account.id}`;
    const text = t.messages[userIndex]!.text;
    if (this.active && this.active.key !== key) this.closeActive();
    // A different effort: Codex changes it per turn; Claude's is per process — reopen (resumes).
    if (this.active && this.active.session.effort !== effort) {
      if (this.active.session.setEffort) this.active.session.setEffort(effort);
      else this.closeActive();
    }
    if (!this.active) {
      const known = t.native[key];
      // Resume the native session only if it saw everything up to now; otherwise carry context.
      const resumeId = known && known.coversUpTo === userIndex ? known.nativeId : undefined;
      const session = catalog.track(await adapters[ref.provider].openSession({account, model: ref.model, systemPrompt: await systemPrompt({tools: !!this.deps.tools, scratch: this.scratch, provider: ref.provider}), resumeId, tools: this.deps.tools?.binding, effort}));
      this.active = {session, key, ref};
      if (!resumeId) t.native[key] = {provider: ref.provider, accountId: account.id, nativeId: '', coversUpTo: 0};
    }
    if (this.active.ref.model !== ref.model) {
      await this.active.session.setModel(ref.model);
      this.active.ref = ref;
    }
    const covers = t.native[key]?.coversUpTo ?? 0;
    // Tool results the new session needs (all if they fit, else the compaction model's picks).
    const tools = carriedTools(t, carryStart(t, covers), userIndex);
    const picked = await selectCarriedTools(tools, text, this.deps.selectCarry);
    const carry = buildCarry(t, covers, userIndex, CARRY_BUDGET_TOKENS, picked.keys);
    const carried =
      picked.how === 'selected' || picked.how === 'recent'
        ? `Context carried over: ${picked.keys.size} of ${tools.length} tool results${picked.how === 'selected' ? ' (chosen by the compaction model)' : ' (most recent)'}, the rest as one-line traces`
        : undefined;
    return {session: this.active.session, prompt: carry.text + text, carried};
  }

  private markCovered(account: Account, session: ProviderSession, upTo: number): void {
    const key = `${session.provider}:${account.id}`;
    const nativeId = session.nativeId();
    if (nativeId) this.transcript.native[key] = {provider: session.provider, accountId: account.id, nativeId, coversUpTo: upTo};
  }

  /** Prompt size at which a conversation on `ref` is compacted (undefined = auto-compact off). */
  private autoCompactLimit(ref: ModelRef): number | undefined {
    const pct = this.deps.config().autoCompactPct;
    if (!pct) return undefined;
    const m = catalog.get(ref);
    const limit = (m?.contextWindow ?? 200_000) * (pct / 100);
    // price-break: stay on the cheaper rate card. Compacting checks a request's prompt after it was
    // sent, and the next tool result adds to it, so the limit sits below the break.
    const experiments = activeExperiments(this.deps.config());
    if (m?.priceBreak && experiments.includes('price-break')) return Math.min(limit, m.priceBreak * PRICE_BREAK_MARGIN);
    // context-cap: on large windows the conversation otherwise grows to 300-500K, and cache reads of it
    // were about 60% of what a large task cost.
    if (experiments.includes('context-cap')) return Math.min(limit, CONTEXT_CAP);
    return limit;
  }

  /**
   * Save the interrupted turn's work as an assistant message, compact everything into the summary
   * (nothing kept verbatim: the turn itself is what filled the context), drop the native session,
   * and add the continuation prompt. Returns the continuation's message index.
   */
  private async *compactAndContinue(ref: ModelRef, account: Account, reply: string, tools: NonNullable<Message['tools']>, fullResults: string[], reason: CompactReason): AsyncGenerator<EngineEvent, number> {
    const t = this.transcript;
    if (reply || tools.length) t.messages.push({role: 'assistant', text: reply, at: Date.now(), model: ref, accountId: account.id, tools: tools.length ? tools : undefined});
    await saveTranscript(t).catch(() => {});
    yield* this.compactWithEvents(reason, 0);
    this.closeActive();
    t.messages.push({role: 'user', text: CONTINUE_AFTER_COMPACTION + recentResults(tools, fullResults), at: Date.now(), synthetic: true});
    await saveTranscript(t).catch(() => {});
    return t.messages.length - 1;
  }

  /** The fill level last warned about, and for which stretch of conversation (a compaction starts a new one). */
  private warned = {segment: -1, level: 0};

  /**
   * Context-bloat warning (config contextWarnings): the first time the context passes 50%, 70% and 85%
   * of the window, say how full it is and what's taking the space, so you can compact or steer it.
   */
  private *contextWarning(ref: ModelRef, input: number | undefined): Generator<EngineEvent> {
    const window = catalog.get(ref)?.contextWindow;
    if (this.deps.config().contextWarnings === false || !input || !window) return;
    const limit = this.autoCompactLimit(ref);
    if (limit && input >= limit) return; // compaction runs right after this anyway
    const segment = this.transcript.summary?.coversUpTo ?? 0;
    if (segment !== this.warned.segment) this.warned = {segment, level: 0};
    const level = [0.85, 0.7, 0.5].find((l) => input / window >= l);
    if (!level || level <= this.warned.level) return;
    this.warned.level = level;
    const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}K`);
    const largest = this.transcript.messages
      .slice(segment)
      .flatMap((m) => m.tools ?? [])
      .map((x) => ({what: `${x.label}(${x.summary.slice(0, 50)})`, tokens: resultTokens(x)}))
      .filter((x) => x.tokens >= 1000)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3);
    yield {
      type: 'notice',
      text: `Context is ${Math.round((input / window) * 100)}% full (${k(input)} of ${k(window)} tokens).${largest.length ? ` Largest: ${largest.map((x) => `${x.what} ${k(x.tokens)}`).join(', ')}.` : ''} /compact summarizes it now (/compact keep <what> steers the summary); /context shows the rest.`,
    };
  }

  private async *maybeAutoCompact(ref: ModelRef, inputTokens: number | undefined): AsyncGenerator<EngineEvent> {
    const limit = this.autoCompactLimit(ref);
    if (!limit) return; // auto-compact off
    const used = inputTokens ?? estimateTokens(this.transcript.messages.map((m) => m.text).join('\n'));
    if (used < limit) return;
    yield* this.compactWithEvents('auto');
    // The native session still holds the full history; start fresh from the summary next turn.
    this.closeActive();
  }

  /** The open session, asked one more turn for its own summary (faithful-compaction); its tokens count. */
  private liveSummarizer(): LiveSummarizer | undefined {
    const session = this.active?.session;
    if (!session) return undefined;
    return async (ask) => {
      let text = '';
      let used: TokenCount | undefined;
      for await (const ev of session.send(ask)) {
        if (ev.type === 'text') text += ev.delta;
        else if (ev.type === 'tokens') used = ev.call;
        else if (ev.type === 'error') throw new Error(ev.message);
      }
      if (used) this.addTokens(used);
      return text;
    };
  }

  /** Run a compaction, surfacing start/end so the UI can animate it and show the result. */
  private async *compactWithEvents(reason: CompactReason, keepRecent?: number): AsyncGenerator<EngineEvent> {
    const messages = compactableCount(this.transcript, keepRecent);
    if (!messages) return;
    yield {type: 'compact', phase: 'start', reason, messages};
    try {
      const result = await this.deps.compact(this.transcript, reason, {...(keepRecent === undefined ? {} : {keepRecent}), model: this.active?.ref, live: this.liveSummarizer()});
      if (!('skipped' in result)) this.cacheBroken = true;
      yield {type: 'compact', phase: 'end', reason, result};
    } catch (err) {
      yield {type: 'notice', text: `Compaction failed: ${(err as Error).message}`};
    }
  }

  private closeActive(): void {
    this.active?.session.close();
    this.active = undefined;
  }
}

const label = (r: ModelRef) => (catalog.get(r)?.label ?? r.model);

/**
 * Waiting for a limit to reset: the longest wait (a weekly limit days away isn't waited for), how
 * often to look for a freed account, and how long after the reset to try. Tests shorten them.
 */
export const limitWait = {maxMs: 12 * 3600_000, pollMs: 60_000, marginMs: 15_000};

/** When the first limited account for `ref` comes back (undefined = none is just limited). */
function earliestReset(ref: ModelRef): number | undefined {
  const resets = catalog.accountsFor(ref).map((a) => usageStore.cooldownUntil(a.id)).filter((x): x is number => !!x);
  return resets.length ? Math.min(...resets) : undefined;
}

function noAccountMessage(ref: ModelRef): string {
  const accounts = catalog.accountsFor(ref);
  if (!accounts.length) return `No signed-in account offers ${label(ref)}. Use /login or /model.`;
  const resets = accounts.map((a) => usageStore.cooldownUntil(a.id)).filter((x): x is number => !!x);
  if (resets.length) return `Every account for ${label(ref)} is at its limit — earliest reset ${clock(Math.min(...resets))}.`;
  return `No healthy account for ${label(ref)} (signed out?). See /login.`;
}

export function clock(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
  return sameDay ? time : `${d.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'})} ${time}`;
}

export {toRef};

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** A chosen level the model doesn't offer → the highest one it has at or below it (else its lowest). */
export function clampEffort(level: string, levels: string[]): string | undefined {
  if (levels.includes(level)) return level;
  const rank = EFFORT_ORDER.indexOf(level);
  const below = levels.filter((l) => EFFORT_ORDER.indexOf(l) <= rank).sort((a, b) => EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a));
  return below[0] ?? levels[0];
}

/**
 * The newest tool results of the interrupted turn, verbatim (newest first, within the carry budget),
 * so the agent keeps its working memory across a mid-turn compaction instead of guessing from the
 * summary's short excerpts.
 */
function recentResults(tools: NonNullable<Message['tools']>, full: string[]): string {
  const picked: string[] = [];
  let used = 0;
  for (let i = tools.length - 1; i >= 0; i--) {
    const c = tools[i]!;
    let block = `<tool_result call="${c.label}(${c.summary})" ok="${c.ok}">\n${full[i] ?? c.result}\n</tool_result>`;
    // The newest result alone is over budget: keep its clipped form rather than nothing.
    if (!picked.length && estimateTokens(block) > CARRY_TOOL_BUDGET) block = `<tool_result call="${c.label}(${c.summary})" ok="${c.ok}">\n${c.result}\n</tool_result>`;
    const cost = estimateTokens(block);
    if (used + cost > CARRY_TOOL_BUDGET) break;
    picked.unshift(block);
    used += cost;
  }
  if (!picked.length) return '';
  const older = tools.length - picked.length;
  return `\n\nYour most recent tool results, verbatim${older ? ` (the ${older} earlier ones are in the summary)` : ''}:\n${picked.join('\n')}`;
}

/** A tool result as kept in the transcript: the first 4,000 characters, marked when there was more. */
function clipResult(result: string): string {
  return result.length > 4000 ? `${result.slice(0, 4000)}\n… [truncated: ${result.length} characters in full — re-run the tool to see the rest]` : result;
}
