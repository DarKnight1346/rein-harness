import type {ModelRef, TokenCount} from './types.js';

/**
 * API list prices (USD per million tokens), so a conversation's cost can be shown in dollars. On a
 * subscription nothing is billed per token: the figure is what the same tokens would cost on the API.
 * Sources (2026-10-09): platform.claude.com/docs/en/about-claude/pricing and
 * developers.openai.com/api/docs/pricing. Config `prices` overrides or adds models.
 */
export type Price = {
  input: number;
  output: number;
  /** Cache hits. */
  cached: number;
  /** Cache writes (Claude): 5-minute and 1-hour. Default: the input price. */
  write5m?: number;
  write1h?: number;
  /** Prompts above this many tokens pay `long` instead (per request: Haiku 5.5, OpenAI long context). */
  longAbove?: number;
  long?: Omit<Price, 'longAbove' | 'long'>;
};

const claude = (input: number, cached: number, output: number): Price => ({input, cached, output, write5m: input * 1.25, write1h: input * 2});

/** Claude: model id patterns (CLI aliases resolve to the current version) → price. First match wins. */
const CLAUDE: [RegExp, Price][] = [
  [/^fable$|fable-5-1|mythos-5-1/, claude(10, 0.25, 50)],
  [/fable-5|mythos-5/, claude(10, 1, 50)],
  [/^opus$|opus-5-5/, claude(4, 0.2, 20)],
  [/opus-5|opus-4-[5-8]/, claude(5, 0.5, 25)],
  [/opus-4/, claude(15, 1.5, 75)],
  [/^sonnet$|sonnet-5-5/, claude(2, 0.1, 10)],
  [/sonnet-5/, claude(2, 0.2, 10)],
  [/sonnet-4/, claude(3, 0.3, 15)],
  [/^haiku$|haiku-5-5/, {...claude(0.1, 0.01, 0.5), longAbove: 100_000, long: claude(0.5, 0.05, 2.5)}],
  [/haiku-4-5/, claude(1, 0.1, 5)],
  [/haiku-3-5/, claude(0.8, 0.08, 4)],
];

const openai = (input: number, cached: number, output: number, long: [number, number, number]): Price => ({input, cached, output, longAbove: 272_000, long: {input: long[0], cached: long[1], output: long[2]}});

const OPENAI: Record<string, Price> = {
  'gpt-6.1-sol': openai(2, 0.1, 10, [4, 0.2, 15]),
  'gpt-6-astra': openai(10, 1, 50, [20, 2, 75]),
  'gpt-6-sol': openai(2, 0.2, 10, [4, 0.4, 15]),
  'gpt-6-luna': openai(0.1, 0.01, 0.5, [0.2, 0.02, 0.75]),
  'gpt-5.6-sol': openai(4, 0.4, 20, [8, 0.8, 30]),
  'gpt-5.6-terra': openai(2, 0.2, 12, [4, 0.4, 18]),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2, [0.4, 0.04, 1.8]),
  'gpt-5.5': openai(5, 0.5, 30, [10, 1, 45]),
};

let overrides: () => Record<string, Price> | undefined = () => undefined;
/** Config `prices` ({"claude:opus": {input, output, cached, …}}), supplied by the runtime. */
export function setPriceOverrides(fn: () => Record<string, Price> | undefined): void {
  overrides = fn;
}

export function priceFor(ref: ModelRef): Price | undefined {
  const o = overrides()?.[`${ref.provider}:${ref.model}`];
  if (o) return o;
  if (ref.provider === 'claude') return CLAUDE.find(([re]) => re.test(ref.model.toLowerCase()))?.[1];
  return OPENAI[ref.model.toLowerCase()];
}

/** Which cache writes Claude Code makes: 1-hour on a subscription, 5-minute with cache-5m or an API key. */
let writeTtl: () => '5m' | '1h' = () => '1h';
export function setCacheWriteTtl(fn: () => '5m' | '1h'): void {
  writeTtl = fn;
}

/**
 * One API request's cost in USD. `input` includes cache hits and writes (as Rein counts it);
 * `written` is the cache-write part, when the CLI reports it. Undefined when the model has no price.
 */
export function requestCost(ref: ModelRef, t: {input: number; cached: number; output: number; written?: number}): number | undefined {
  const base = priceFor(ref);
  if (!base) return undefined;
  const p = base.long && base.longAbove !== undefined && t.input > base.longAbove ? {...base, ...base.long} : base;
  const written = Math.min(t.written ?? 0, Math.max(0, t.input - t.cached));
  const plain = Math.max(0, t.input - t.cached - written);
  const write = (writeTtl() === '5m' ? p.write5m : p.write1h) ?? p.input;
  return (plain * p.input + written * write + t.cached * p.cached + t.output * p.output) / 1e6;
}

/** Add two counts; `usd` stays undefined only when neither side has one. */
export function addTokens(a: TokenCount, b: TokenCount): TokenCount {
  const usd = a.usd === undefined && b.usd === undefined ? undefined : (a.usd ?? 0) + (b.usd ?? 0);
  const written = a.written === undefined && b.written === undefined ? undefined : (a.written ?? 0) + (b.written ?? 0);
  return {input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, ...(written === undefined ? {} : {written}), ...(usd === undefined ? {} : {usd})};
}

/** A request's counts with its cost filled in. */
export function priced(ref: ModelRef, t: TokenCount): TokenCount {
  const usd = requestCost(ref, t);
  return usd === undefined ? t : {...t, usd};
}

/** "$0.42", "$12.30", "<$0.01". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
