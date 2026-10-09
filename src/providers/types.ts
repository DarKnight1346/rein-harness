export type ProviderId = 'claude' | 'codex';

export const PROVIDERS: Record<ProviderId, {name: string}> = {
  claude: {name: 'Claude'},
  codex: {name: 'Codex'},
};

export type Account = {
  id: string;
  provider: ProviderId;
  /** Config dir for the CLI. `null` = the CLI's default dir (~/.claude, ~/.codex); env var is left unset. */
  home: string | null;
  /** Imported from an existing login: Rein never logs it out or deletes its dir. */
  imported: boolean;
  label?: string;
  email?: string;
  plan?: string;
  /**
   * API accounts (pay per use) instead of a subscription: `console` (Anthropic Console key, the
   * CLI's own `auth login --console`), `bedrock` / `vertex` (Claude through AWS / Google Cloud,
   * your own cloud credentials), `openai` (an OpenAI API key, Codex's own API-key login).
   * Subscriptions leave it unset.
   */
  api?: 'console' | 'bedrock' | 'vertex' | 'openai';
  /** Non-secret settings for Bedrock / Vertex (credentials come from your AWS / Google setup). */
  apiConfig?: {region?: string; profile?: string; projectId?: string};
  /** REIN_ENV_KEYS: a one-run account using the API key in the environment (never saved). */
  envKey?: boolean;
};

export const isApiAccount = (a: Pick<Account, 'api'>) => !!a.api;

export type AccountStatus =
  | {loggedIn: true; email?: string; plan?: string}
  | {loggedIn: false; error?: string};

/** Events from an interactive login. The UI renders these and answers `needsCode`. */
export type LoginEvent =
  | {type: 'url'; url: string}
  | {type: 'needsCode'}
  | {type: 'output'; text: string}
  | {type: 'done'; status: AccountStatus}
  | {type: 'error'; message: string};

export type LoginFlow = {
  events: AsyncIterable<LoginEvent>;
  /** Forward a pasted authorization code (Claude's paste-the-code flow). */
  submitCode(code: string): void;
  cancel(): void;
};

export interface ProviderAuth {
  id: ProviderId;
  status(account: Account): Promise<AccountStatus>;
  login(account: Account): LoginFlow;
  logout(account: Account): Promise<void>;
}

/** A model as offered by a provider. `tier`: relative cost, 1 = cheapest. */
export type ModelInfo = {
  provider: ProviderId;
  id: string;
  label: string;
  description?: string;
  tier: number;
  contextWindow: number;
  isDefault?: boolean;
  /** Effort levels the model accepts, lowest first, and its default. */
  efforts?: string[];
  defaultEffort?: string;
  /** Prompt size above which every token is billed at a higher rate (Haiku 5.5: 5x above 100K). */
  priceBreak?: number;
};

/** `provider:model`, e.g. `claude:sonnet`, `codex:gpt-6-luna`. */
export type ModelRef = {provider: ProviderId; model: string};
export const refKey = (r: ModelRef) => `${r.provider}:${r.model}`;
export function parseRef(s: string): ModelRef | undefined {
  const m = /^(claude|codex):(.+)$/.exec(s.trim());
  return m ? {provider: m[1] as ProviderId, model: m[2]!} : undefined;
}

export type UsageWindow = {
  /** 0–100. */
  usedPct: number;
  resetsAt?: number; // epoch ms
  /** Window length in minutes: 300 = 5h, 10080 = weekly, 43200 = 30-day. */
  windowMins: number;
};

export type UsageSnapshot = {
  windows: UsageWindow[];
  /** epoch ms when observed */
  at: number;
  source: 'live' | 'from-limit-error';
  /** Provider says requests are currently rejected. */
  limited?: boolean;
};

export type ChatErrorKind = 'limit' | 'auth' | 'context' | 'overloaded' | 'other';

/** Tokens for the current call so far: `input` = all input incl. cached, `cached` = cache reads. */
/** `input` includes cache hits (`cached`) and cache writes (`written`, when known); `usd` at API list prices. */
export type TokenCount = {input: number; cached: number; output: number; written?: number; usd?: number};

export type ChatEvent =
  | {type: 'text'; delta: string}
  | {type: 'tokens'; call: TokenCount}
  | {type: 'usage'; usage: UsageSnapshot}
  | {type: 'done'; interrupted: boolean; tokens?: {input: number; output: number}; contextWindow?: number}
  | {type: 'error'; kind: ChatErrorKind; message: string; resetsAt?: number};

/** An image attached to a user turn (stored as a file in the session's scratch folder). */
export type ImageInput = {path: string; mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'};

export interface ProviderSession {
  readonly provider: ProviderId;
  readonly accountId: string;
  model: string;
  /** Native session/thread id, for resume. */
  nativeId(): string | undefined;
  /** Effort the session runs at (undefined = model default). */
  readonly effort?: string;
  /** Change effort in place (Codex: per turn). Absent = fixed per process (Claude: reopen). */
  setEffort?(effort: string | undefined): void;
  /** One turn. Ends with exactly one `done` or `error`. */
  send(text: string, images?: ImageInput[]): AsyncIterable<ChatEvent>;
  interrupt(): void;
  setModel(model: string): Promise<void>;
  close(): void;
}

/** Rein's tool runtime as seen by providers (implemented by tools/host.ts). */
export type ToolBinding = {
  tools: {name: string; description: string; inputSchema: Record<string, unknown>}[];
  call(name: string, args: unknown): Promise<{ok: boolean; text: string; images?: {mime: string; base64: string}[]}>;
  /** Unix socket for out-of-process callers (Claude's MCP proxy). */
  listen(): Promise<string>;
  /** Tool names the model may call (default: all). Forks allow only read-only tools. */
  allowed?: string[];
  proxy: {command: string; args: string[]};
};

export type SessionOpts = {
  account: Account;
  model: string;
  systemPrompt: string;
  /** Resume a native session instead of starting fresh. */
  resumeId?: string;
  /** Give the model Rein's tools (chat sessions only; one-shots never get tools). */
  tools?: ToolBinding;
  /** Effort level (undefined = the model's default). */
  effort?: string;
};

/** `fast`: latency over depth (decider calls): no extended thinking / low reasoning effort. */
export type OneShotOpts = {
  account: Account;
  model: string;
  system: string;
  prompt: string;
  timeoutMs?: number;
  fast?: boolean;
  /** Turn on the provider's own server-side web search for this call only (Rein's web_search tool). */
  webSearch?: boolean;
};

export interface ProviderAdapter extends ProviderAuth {
  listModels(account: Account): Promise<ModelInfo[]>;
  /** Live usage if cheaply available (Codex), else undefined (Claude: see refreshUsage). */
  readUsage(account: Account): Promise<UsageSnapshot | undefined>;
  /** Force a fresh usage reading, possibly by making a tiny request (Claude). */
  refreshUsage(account: Account): Promise<UsageSnapshot | undefined>;
  openSession(opts: SessionOpts): Promise<ProviderSession>;
  oneShot(opts: OneShotOpts): Promise<string>;
  version(): Promise<string | undefined>;
  /** Run the CLI's self-update; yields output lines. */
  update(): AsyncIterable<string>;
  /** Stop background processes (Codex app-servers). */
  shutdown(): void;
  /**
   * Branch the native session `nativeId` (full history incl. tool results) and run one turn on the
   * branch; the original session is untouched and can keep running. Used by /btw.
   */
  fork(opts: ForkOpts): Promise<ProviderSession>;
}

export type ForkOpts = {account: Account; model: string; systemPrompt: string; nativeId: string; tools?: ToolBinding};
