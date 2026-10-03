import {adapters} from '../providers/index.js';
import type {Account, ChatEvent, ImageInput, ModelRef, ProviderSession, TokenCount, ToolBinding} from '../providers/types.js';
import type {ToolActivity} from '../tools/host.js';
import {EventQueue} from '../util/proc.js';
import {refKey} from '../providers/types.js';
import {catalog, toRef} from '../router/catalog.js';
import type {Config} from '../store/config.js';
import {usageStore} from '../store/usage.js';
import {compactableCount, compactTranscript, type CompactReason, type CompactResult} from './compactor.js';
import {systemPrompt} from './prompt.js';
import {buildCarry, estimateTokens, newTranscript, saveTranscript, scratchDir, type Message, type Transcript} from './transcript.js';

export type Route = {ref: ModelRef; reason: 'fixed' | 'auto' | 'sticky' | 'default' | 'failover'; confidence?: number};

export type EngineEvent =
  | {type: 'route'; route: Route; account: Account}
  | {type: 'tool'; activity: ToolActivity}
  | {type: 'tokens'; call: TokenCount}
  | {type: 'compact'; phase: 'start'; reason: CompactReason; messages: number}
  | {type: 'compact'; phase: 'end'; reason: CompactReason; result: CompactResult}
  | {type: 'text'; delta: string}
  | {type: 'notice'; text: string}
  | {type: 'done'; interrupted: boolean}
  | {type: 'error'; message: string};

export type EngineDeps = {
  config: () => Config;
  /** Pick the model for this message (fixed or auto). */
  route: (text: string, t: Transcript, current: ModelRef | undefined) => Promise<Route>;
  /** Pick a replacement model when every account for `failed` is unavailable. */
  alternative: (text: string, t: Transcript, failed: ModelRef, exclude: ReadonlySet<string>) => Promise<ModelRef | undefined>;
  /** Summarize older messages into `t.summary` (M6). */
  compact: (t: Transcript, reason: CompactReason) => Promise<CompactResult>;
  /** Rein's tools for chat sessions, plus their activity feed (tool lines in the transcript). */
  tools?: {binding: ToolBinding; forkBinding?: ToolBinding; onActivity(fn: (a: ToolActivity) => void): () => void};
};

/** Context carried into a fresh native session before compaction kicks in. */
const CARRY_BUDGET_TOKENS = 24_000;
const MAX_ATTEMPTS = 5;

/**
 * Owns the conversation. Rein's transcript is the source of truth; native sessions are caches
 * reused while provider+account stay the same.
 */
export class Engine {
  transcript: Transcript;
  private active: {session: ProviderSession; key: string; ref: ModelRef} | undefined;
  private running: ProviderSession | undefined;
  private interruptRequested = false;
  /** Tokens of the call in flight (live), folded into `transcript.tokens` when it ends. */
  callTokens: TokenCount | undefined;

  /** Conversation totals including the call in flight. */
  get sessionTokens(): {uncached: number; cached: number; output: number} {
    const base = this.transcript.tokens ?? {uncached: 0, cached: 0, output: 0};
    const c = this.callTokens;
    return c ? {uncached: base.uncached + c.input - c.cached, cached: base.cached + c.cached, output: base.output + c.output} : base;
  }

  private commitCallTokens(): void {
    if (!this.callTokens) return;
    this.transcript.tokens = this.sessionTokens;
    this.callTokens = undefined;
  }

  /** Tokens the provider reported for the last completed request (for /context). */
  lastUsage: {ref: ModelRef; input: number; output: number; at: number} | undefined;

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
      systemPrompt: await systemPrompt({tools: !!this.deps.tools, scratch: this.scratch}),
      nativeId,
      tools,
    });
  }

  /** Add tokens spent outside the main turn (subagents) to the conversation totals. */
  addTokens(t: TokenCount): void {
    const base = this.transcript.tokens ?? {uncached: 0, cached: 0, output: 0};
    this.transcript.tokens = {uncached: base.uncached + t.input - t.cached, cached: base.cached + t.cached, output: base.output + t.output};
  }

  get isBusy(): boolean {
    return !!this.running;
  }

  interrupt(): void {
    this.interruptRequested = true;
    this.running?.interrupt();
  }

  /** `/compact`: summarize now; the next turn starts a fresh native session from the summary. */
  async compactNow(): Promise<CompactResult> {
    const res = await compactTranscript(this.transcript, this.deps.config(), {keepRecent: 2});
    if (!('skipped' in res)) this.closeActive();
    return res;
  }

  /** Switch to a saved conversation (`rein --continue` picker / `/resume`). */
  load(t: Transcript): void {
    this.closeActive();
    this.transcript = t;
    this.lastUsage = undefined;
    this.callTokens = undefined;
  }

  /**
   * Tool definitions changed (e.g. the advisor was switched on): drop the live native session; the
   * next turn resumes it (same history) with the new tool list.
   */
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
  }

  shutdown(): void {
    this.closeActive();
  }

  async *send(text: string, images: ImageInput[] = []): AsyncGenerator<EngineEvent> {
    const t = this.transcript;
    const cfg = this.deps.config();
    t.messages.push({role: 'user', text, at: Date.now(), ...(images.length ? {images} : {})});
    const userIndex = t.messages.length - 1;
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
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this.interruptRequested) {
        yield {type: 'done', interrupted: true};
        return;
      }
      const account = this.pickAccount(route.ref, excluded, cfg.maxUsedPct);
      if (!account) {
        const alt = await this.deps.alternative(text, t, route.ref, excluded).catch(() => undefined);
        if (!alt || refKey(alt) === refKey(route.ref)) {
          yield {type: 'error', message: noAccountMessage(route.ref)};
          return;
        }
        yield {type: 'notice', text: `No ${label(route.ref)} account available — switching to ${label(alt)}`};
        route = {ref: alt, reason: 'failover'};
        continue;
      }

      let session: ProviderSession;
      let prompt: string;
      try {
        ({session, prompt} = await this.prepare(route.ref, account, userIndex));
      } catch (err) {
        catalog.authFailed.add(account.id);
        excluded.add(account.id);
        yield {type: 'notice', text: `${account.email ?? account.id}: ${(err as Error).message}`};
        continue;
      }
      if (estimateTokens(prompt) > CARRY_BUDGET_TOKENS + estimateTokens(text) && !compacted) {
        compacted = true;
        yield* this.compactWithEvents('handoff');
        ({prompt} = await this.prepare(route.ref, account, userIndex));
      }

      yield {type: 'route', route, account};
      let reply = '';
      const replyTools: NonNullable<Message['tools']> = [];
      let failure: {kind: string; message: string; resetsAt?: number} | undefined;
      this.running = session;
      for await (const ev of this.withToolActivity(session.send(prompt, images))) {
        if (ev.type === 'tool') {
          const a = ev.activity;
          if (a.origin) continue; // a subagent's tool call: shown in its own view, not here
          if (a.phase === 'end') replyTools.push({label: a.label, summary: a.summary, ok: a.ok, result: a.result.slice(0, 4000), diff: a.diff});
          yield ev;
          continue;
        }
        if (ev.type === 'tokens') {
          this.callTokens = ev.call;
          yield ev;
          continue;
        }
        if (ev.type === 'text') {
          reply += ev.delta;
          yield {type: 'text', delta: ev.delta};
        } else if (ev.type === 'done') {
          this.running = undefined;
          this.commitCallTokens();
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
          yield {type: 'done', interrupted: ev.interrupted};
          yield* this.maybeAutoCompact(route.ref, ev.tokens?.input);
          return;
        } else if (ev.type === 'error') {
          failure = ev;
        }
      }
      this.running = undefined;
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

  private pickAccount(ref: ModelRef, excluded: ReadonlySet<string>, maxUsedPct: number): Account | undefined {
    const healthy = catalog.healthyAccounts(ref, maxUsedPct, excluded);
    // Stay on the active account while it's healthy: keeps the native session (and its cache) warm.
    const activeId = this.active?.session.accountId;
    return healthy.find((a) => a.id === activeId) ?? healthy[0];
  }

  /** Reuse or open the native session for (provider, account) and build the prompt with carry. */
  private async prepare(ref: ModelRef, account: Account, userIndex: number): Promise<{session: ProviderSession; prompt: string}> {
    const t = this.transcript;
    const key = `${ref.provider}:${account.id}`;
    const text = t.messages[userIndex]!.text;
    if (this.active && this.active.key !== key) this.closeActive();
    if (!this.active) {
      const known = t.native[key];
      // Resume the native session only if it saw everything up to now; otherwise carry context.
      const resumeId = known && known.coversUpTo === userIndex ? known.nativeId : undefined;
      const session = await adapters[ref.provider].openSession({account, model: ref.model, systemPrompt: await systemPrompt({tools: !!this.deps.tools, scratch: this.scratch}), resumeId, tools: this.deps.tools?.binding});
      this.active = {session, key, ref};
      if (!resumeId) t.native[key] = {provider: ref.provider, accountId: account.id, nativeId: '', coversUpTo: 0};
    }
    if (this.active.ref.model !== ref.model) {
      await this.active.session.setModel(ref.model);
      this.active.ref = ref;
    }
    const covers = t.native[key]?.coversUpTo ?? 0;
    const carry = buildCarry(t, covers, userIndex, CARRY_BUDGET_TOKENS);
    return {session: this.active.session, prompt: carry.text + text};
  }

  private markCovered(account: Account, session: ProviderSession, upTo: number): void {
    const key = `${session.provider}:${account.id}`;
    const nativeId = session.nativeId();
    if (nativeId) this.transcript.native[key] = {provider: session.provider, accountId: account.id, nativeId, coversUpTo: upTo};
  }

  private async *maybeAutoCompact(ref: ModelRef, inputTokens: number | undefined): AsyncGenerator<EngineEvent> {
    const pct = this.deps.config().autoCompactPct;
    if (!pct) return; // auto-compact off
    const window = catalog.get(ref)?.contextWindow ?? 200_000;
    const used = inputTokens ?? estimateTokens(this.transcript.messages.map((m) => m.text).join('\n'));
    if (used < window * (pct / 100)) return;
    yield* this.compactWithEvents('auto');
    // The native session still holds the full history; start fresh from the summary next turn.
    this.closeActive();
  }

  /** Run a compaction, surfacing start/end so the UI can animate it and show the result. */
  private async *compactWithEvents(reason: CompactReason): AsyncGenerator<EngineEvent> {
    const messages = compactableCount(this.transcript);
    if (!messages) return;
    yield {type: 'compact', phase: 'start', reason, messages};
    try {
      const result = await this.deps.compact(this.transcript, reason);
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
