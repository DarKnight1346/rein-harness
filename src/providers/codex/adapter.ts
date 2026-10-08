import {usageStore} from '../../store/usage.js';
import {EventQueue, run} from '../../util/proc.js';
import {streamCommand} from '../claude/adapter.js';
import {accountEnv} from '../env.js';
import {reportSideUsage} from '../usage.js';
import type {
  Account,
  ChatErrorKind,
  ChatEvent,
  ModelInfo,
  ProviderAdapter,
  ProviderSession,
  SessionOpts,
  ForkOpts,
  ImageInput,
  ToolBinding,
  TokenCount,
  UsageSnapshot,
  UsageWindow,
} from '../types.js';
import {AppServerClient, type Notification} from './appServer.js';
import {codexAuth} from './auth.js';
import {appServerArgs, cacheIsFresh, codexTier, contextWindows, readModelsCache, writeReinCatalog} from './catalog.js';
import {codexCompat} from './compat.js';

const codexBin = () => process.env.REIN_CODEX_BIN ?? 'codex';

/** Dynamic-tool calls by thread id → the session's tool binding. */
const toolsByThread = new Map<string, ToolBinding>();

/**
 * Codex built-in tools are stripped, so approvals are declined and user-input requests answered
 * empty. Rein's own tools arrive as dynamic-tool calls (`item/tool/call`).
 */
async function declineServerRequest(method: string, params?: any): Promise<unknown> {
  if (method === 'item/tool/call') {
    const tools = toolsByThread.get(params?.threadId);
    if (!tools) return {contentItems: [{type: 'inputText', text: 'tools are not available in this thread'}], success: false};
    const res = await tools.call(String(params.tool), params.arguments);
    const images = (res.images ?? []).map((i) => ({type: 'inputImage', imageUrl: `data:${i.mime};base64,${i.base64}`}));
    return {contentItems: [{type: 'inputText', text: res.text}, ...images], success: res.ok};
  }
  if (method.endsWith('requestApproval') || method === 'applyPatchApproval' || method === 'execCommandApproval') {
    return {decision: 'decline'};
  }
  if (method === 'item/tool/requestUserInput') return {answers: {}};
  throw {code: -32601, message: `rein does not handle ${method}`};
}

/** One long-lived app-server per account, started with the tool-less catalog. */
class AppServerPool {
  private clients = new Map<string, Promise<AppServerClient>>();

  get(account: Account): Promise<AppServerClient> {
    let p = this.clients.get(account.id);
    if (!p) {
      p = this.start(account);
      this.clients.set(account.id, p);
      p.then(
        (c) => c.onExit(() => this.clients.delete(account.id)),
        () => this.clients.delete(account.id),
      );
    }
    return p;
  }

  private async start(account: Account): Promise<AppServerClient> {
    if (!cacheIsFresh(await readModelsCache(account))) {
      // `model/list` on a plain app-server refreshes <CODEX_HOME>/models_cache.json.
      const plain = await AppServerClient.start(account, {onServerRequest: declineServerRequest});
      try {
        await plain.request('model/list', {});
      } catch {
        // logged out or offline: fall through with whatever cache exists
      } finally {
        plain.close();
      }
    }
    const catalogPath = await writeReinCatalog(account);
    // experimentalApi: required for dynamic (client-side) tools.
    const features = (await codexCompat().catch(() => undefined))?.features;
    const client = await AppServerClient.start(account, {args: appServerArgs(catalogPath, features), onServerRequest: declineServerRequest, experimental: true});
    client.onNotification((n) => {
      if (n.method === 'account/rateLimits/updated') mergeRateLimits(account.id, n.params?.rateLimits);
    });
    return client;
  }

  shutdown(): void {
    for (const p of this.clients.values()) void p.then((c) => c.close(), () => {});
    this.clients.clear();
  }

  /** Stop one account's app-server (the account was removed). */
  release(accountId: string): void {
    void this.clients.get(accountId)?.then((c) => c.close(), () => {});
    this.clients.delete(accountId);
  }
}

/** Stop the app-server of a removed Codex account. */
export const releaseCodexAccount = (accountId: string) => pool.release(accountId);

const pool = new AppServerPool();

function toWindow(w: any): UsageWindow | undefined {
  if (!w || typeof w.usedPercent !== 'number') return undefined;
  return {usedPct: w.usedPercent, resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined, windowMins: w.windowDurationMins ?? 0};
}

/** Map windows by duration, not primary/secondary position (free plan: one 30-day window). */
export function snapshotFromRateLimits(rl: any, ordinaryUsageAllowed = true, now = Date.now()): UsageSnapshot | undefined {
  if (!rl) return undefined;
  const windows = [toWindow(rl.primary), toWindow(rl.secondary)].filter((w): w is UsageWindow => !!w);
  windows.sort((a, b) => a.windowMins - b.windowMins);
  const limited = !ordinaryUsageAllowed || !!rl.rateLimitReachedType || windows.some((w) => w.usedPct >= 100);
  return {windows, at: now, source: 'live', limited};
}

function mergeRateLimits(accountId: string, rl: any): void {
  const fresh = snapshotFromRateLimits(rl);
  if (!fresh) return;
  // Sparse update: keep previously seen windows the update doesn't mention.
  const prev = usageStore.get(accountId);
  const windows = [...fresh.windows];
  for (const w of prev?.windows ?? []) if (!windows.some((x) => x.windowMins === w.windowMins)) windows.push(w);
  windows.sort((a, b) => a.windowMins - b.windowMins);
  usageStore.set(accountId, {...fresh, windows});
}

async function readUsage(account: Account): Promise<UsageSnapshot | undefined> {
  const client = await pool.get(account);
  const res = await client.request('account/rateLimits/read');
  const snap = snapshotFromRateLimits(res?.rateLimits, res?.ordinaryUsageAllowed ?? true);
  if (snap) usageStore.set(account.id, snap);
  return snap;
}

export function classifyCodexError(err: any): ChatErrorKind {
  const info = err?.codexErrorInfo;
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'sessionBudgetExceeded') return 'limit';
  if (info === 'contextWindowExceeded') return 'context';
  if (info === 'serverOverloaded') return 'overloaded';
  const status = info && typeof info === 'object' ? (Object.values(info)[0] as any)?.httpStatusCode : undefined;
  if (status === 401 || status === 403 || /unauthori[sz]ed|log ?in again|refresh token/i.test(err?.message ?? '')) return 'auth';
  return 'other';
}

class CodexSession implements ProviderSession {
  readonly provider = 'codex' as const;
  readonly accountId: string;
  model: string;
  private threadId: string | undefined;
  private turn:
    | {id?: string; queue: EventQueue<ChatEvent>; interrupted: boolean; error?: any; tokens?: {input: number; output: number}; hasText?: boolean; call: TokenCount}
    | undefined;
  private off: (() => void) | undefined;

  /** Reasoning effort per turn (`low` for decider calls); undefined = model default. */
  effort: string | undefined;
  setEffort(effort: string | undefined): void {
    this.effort = effort;
  }

  /** Images produced by Codex's image generation during this session's turns. */
  readonly generated: GeneratedImage[] = [];

  private constructor(private readonly client: AppServerClient, private readonly account: Account, model: string) {
    this.accountId = account.id;
    this.model = model;
  }

  /** /btw: `thread/fork` (ephemeral) → a new thread with the full history; the original keeps running. */
  static async fork(opts: ForkOpts): Promise<CodexSession> {
    const client = await pool.get(opts.account);
    const s = new CodexSession(client, opts.account, opts.model);
    // excludeTurns: required for ephemeral forks; it only omits past turns from the response payload.
    const res = await client.request('thread/fork', {threadId: opts.nativeId, ephemeral: true, excludeTurns: true, model: opts.model, approvalPolicy: 'untrusted', sandbox: 'read-only'});
    s.threadId = res.thread?.id;
    if (s.threadId && opts.tools) toolsByThread.set(s.threadId, opts.tools);
    s.off = client.onNotification((n) => s.onNotification(n));
    return s;
  }

  static async open(opts: SessionOpts & {ephemeral?: boolean; webSearch?: boolean; imageGeneration?: boolean}): Promise<CodexSession> {
    const dynamicTools = opts.tools?.tools.map((t) => ({type: 'function', name: t.name, description: t.description, inputSchema: t.inputSchema}));
    const client = await pool.get(opts.account);
    const s = new CodexSession(client, opts.account, opts.model);
    const common = {
      model: opts.model,
      baseInstructions: opts.systemPrompt,
      personality: 'none',
      // `untrusted`: if a new model ever slips tools past the catalog, they become approval
      // requests that Rein declines instead of running in the sandbox.
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      cwd: process.cwd(),
    };
    const res = opts.resumeId
      ? await client.request('thread/resume', {threadId: opts.resumeId, ...common})
      : await client.request('thread/start', {
          ...common,
          ephemeral: opts.ephemeral ?? false,
          ...(dynamicTools ? {dynamicTools} : {}),
          // Per-thread overrides: the app-server runs with web search and image generation
          // disabled for every other thread.
          ...(opts.webSearch || opts.imageGeneration
            ? {config: {...(opts.webSearch ? {web_search: 'live'} : {}), ...(opts.imageGeneration ? {features: {image_generation: true}} : {})}}
            : {}),
        });
    if (opts.effort) s.effort = opts.effort;
    s.threadId = res.thread?.id;
    if (s.threadId && opts.tools) toolsByThread.set(s.threadId, opts.tools);
    s.off = client.onNotification((n) => s.onNotification(n));
    return s;
  }

  nativeId() {
    return this.threadId;
  }

  send(text: string, images: ImageInput[] = []): AsyncIterable<ChatEvent> {
    const queue = new EventQueue<ChatEvent>();
    if (this.turn || !this.threadId) {
      queue.push({type: 'error', kind: 'other', message: this.turn ? 'a turn is already running' : 'no thread'});
      queue.end();
      return queue;
    }
    const turn: NonNullable<CodexSession['turn']> = {queue, interrupted: false, call: {input: 0, cached: 0, output: 0}};
    this.turn = turn;
    this.client
      .request('turn/start', {threadId: this.threadId, input: [...images.map((img) => ({type: 'localImage', path: img.path})), {type: 'text', text, text_elements: []}], model: this.model, ...(this.effort ? {effort: this.effort} : {})})
      .then((res) => {
        turn.id = res.turn?.id;
        if (turn.interrupted && turn.id) void this.client.request('turn/interrupt', {threadId: this.threadId, turnId: turn.id}).catch(() => {});
      })
      .catch((err) => this.finish({type: 'error', kind: classifyCodexError(err.error ?? err), message: err.message}));
    return queue;
  }

  interrupt(): void {
    if (!this.turn || this.turn.interrupted) return;
    this.turn.interrupted = true;
    if (this.turn.id) void this.client.request('turn/interrupt', {threadId: this.threadId, turnId: this.turn.id}).catch(() => {});
  }

  async setModel(model: string): Promise<void> {
    this.model = model; // Codex takes the model per turn
  }

  close(): void {
    if (this.threadId) toolsByThread.delete(this.threadId);
    this.off?.();
    if (this.turn) this.finish({type: 'done', interrupted: true});
  }

  private onNotification(n: Notification): void {
    const p = n.params ?? {};
    if (!this.turn || p.threadId !== this.threadId) return;
    if (n.method === 'item/completed' && p.item?.type === 'imageGeneration') {
      const i = p.item;
      this.generated.push({base64: i.result ?? '', revisedPrompt: i.revisedPrompt ?? undefined, savedPath: i.savedPath ?? undefined, failure: i.failure ?? undefined});
    } else if (n.method === 'item/started' && p.item?.type === 'agentMessage' && this.turn.hasText) {
      this.turn.queue.push({type: 'text', delta: '\n\n'}); // new message after a tool call
    } else if (n.method === 'thread/tokenUsage/updated') {
      // `last` = the latest model request; a turn with tool calls makes several, so sum them.
      const last = p.tokenUsage?.last;
      if (last) {
        const t = this.turn;
        t.call = {input: t.call.input + (last.inputTokens ?? 0), cached: t.call.cached + (last.cachedInputTokens ?? 0), output: t.call.output + (last.outputTokens ?? 0)};
        t.tokens = {input: last.inputTokens ?? 0, output: last.outputTokens ?? 0};
        t.queue.push({type: 'tokens', call: t.call});
      }
    } else if (n.method === 'item/agentMessage/delta') {
      if (p.delta) this.turn.hasText = true;
      this.turn.queue.push({type: 'text', delta: p.delta ?? ''});
    } else if (n.method === 'error' && !p.willRetry) {
      this.turn.error = p.error;
    } else if (n.method === 'turn/completed') {
      const status = p.turn?.status;
      if (status === 'interrupted' || this.turn.interrupted) this.finish({type: 'done', interrupted: true});
      else if (status === 'failed' || this.turn.error) void this.fail(p.turn?.error ?? this.turn.error);
      else this.finish({type: 'done', interrupted: false, tokens: this.turn.tokens});
    }
  }

  private async fail(err: any): Promise<void> {
    const kind = classifyCodexError(err);
    let resetsAt: number | undefined;
    if (kind === 'limit') {
      const snap = await readUsage(this.account).catch(() => undefined);
      const full = snap?.windows.filter((w) => w.usedPct >= 100 && w.resetsAt).map((w) => w.resetsAt!);
      resetsAt = full?.length ? Math.max(...full) : undefined;
      usageStore.coolDown(this.accountId, resetsAt ?? Date.now() + 15 * 60_000);
    }
    this.finish({type: 'error', kind, message: err?.message ?? 'turn failed', resetsAt});
  }

  private finish(ev: ChatEvent): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.queue.push(ev);
    turn.queue.end();
  }
}

export const codexAdapter: ProviderAdapter = {
  ...codexAuth,

  async listModels(account) {
    const client = await pool.get(account);
    const res = await client.request('model/list', {});
    const windows = await contextWindows(account);
    return (res.data ?? [])
      .filter((m: any) => !m.hidden)
      .map((m: any): ModelInfo => ({
        provider: 'codex',
        id: m.id ?? m.model,
        label: m.displayName ?? m.id,
        description: m.description ?? undefined,
        tier: codexTier(m.id, m.description ?? ''),
        contextWindow: windows.get(m.id) ?? 128_000,
        isDefault: !!m.isDefault,
        efforts: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map((o: any) => String(o?.reasoningEffort ?? o?.effort ?? o)).filter(Boolean) : undefined,
        defaultEffort: m.defaultReasoningEffort ?? undefined,
      }));
  },

  readUsage,
  refreshUsage: readUsage,

  openSession(opts) {
    return CodexSession.open(opts);
  },

  fork(opts) {
    return CodexSession.fork(opts);
  },

  async oneShot({account, model, system, prompt, timeoutMs, fast, webSearch}) {
    const session = await CodexSession.open({account, model, systemPrompt: system, ephemeral: true, webSearch});
    if (fast) session.effort = 'low';
    const timer = setTimeout(() => session.interrupt(), timeoutMs ?? 60_000);
    let used: TokenCount | undefined;
    try {
      let text = '';
      for await (const ev of session.send(prompt)) {
        if (ev.type === 'text') text += ev.delta;
        else if (ev.type === 'tokens') used = ev.call;
        else if (ev.type === 'error') throw Object.assign(new Error(ev.message), {kind: ev.kind});
        else if (ev.type === 'done' && ev.interrupted) throw new Error('timed out');
      }
      return text;
    } finally {
      clearTimeout(timer);
      session.close();
      reportSideUsage({provider: 'codex', model}, used);
    }
  },

  async version() {
    try {
      const res = await run(codexBin(), ['--version'], {timeoutMs: 15_000});
      return res.stdout.trim().split(/\s+/).at(-1) || undefined;
    } catch {
      return undefined;
    }
  },

  update() {
    const env = accountEnv({id: 'update', provider: 'codex', home: null, imported: true});
    return streamCommand(codexBin(), ['update'], env);
  },

  shutdown() {
    pool.shutdown();
  },
};

/** One image from Codex's image generation (base64 PNG; `failure` when a usage limit was hit). */
export type GeneratedImage = {base64: string; revisedPrompt?: string; savedPath?: string; failure?: {type: string; resetsAt?: number | null}};

/**
 * Rein's image_generate tool: one ephemeral Codex thread with image generation switched on for
 * that thread only. `inputImages` are reference/edit sources. Returns the images and the reply.
 */
export async function codexGenerateImage(opts: {account: Account; model: string; prompt: string; inputImages?: ImageInput[]; timeoutMs?: number}): Promise<{images: GeneratedImage[]; text: string}> {
  const session = await CodexSession.open({
    account: opts.account,
    model: opts.model,
    systemPrompt: 'You generate images with your image generation tool. Make exactly what is asked (one image unless told otherwise), then reply with one short sentence describing it.',
    ephemeral: true,
    imageGeneration: true,
  });
  const timer = setTimeout(() => session.interrupt(), opts.timeoutMs ?? 300_000);
  try {
    let text = '';
    for await (const ev of session.send(opts.prompt, opts.inputImages ?? [])) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'error') throw Object.assign(new Error(ev.message), {kind: ev.kind});
      else if (ev.type === 'done' && ev.interrupted) throw new Error('image generation timed out');
    }
    return {images: session.generated, text: text.trim()};
  } finally {
    clearTimeout(timer);
    session.close();
  }
}
