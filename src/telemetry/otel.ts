import {randomBytes} from 'node:crypto';
import type {ModelRef, TokenCount} from '../providers/types.js';
import type {Config} from '../store/config.js';
import type {ToolActivity} from '../tools/host.js';

/**
 * OpenTelemetry export (config `otel`, off by default): each turn as a trace (a `rein.turn` span with
 * a `rein.tool` child per tool call) and token, cost and tool counters as metrics, sent as OTLP/HTTP
 * JSON to `<endpoint>/v1/traces` and `/v1/metrics`. Only metadata leaves the machine: model, tool
 * names, durations, outcomes and token counts, never prompts, replies, file contents or commands.
 */
export type OtelConfig = {endpoint?: string; headers?: Record<string, string>; serviceName?: string};

type Span = {traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string; attributes: Attr[]; status: {code: number}};
type Attr = {key: string; value: {stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean}};

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const attr = (key: string, v: string | number | boolean | undefined): Attr[] =>
  v === undefined ? [] : [{key, value: typeof v === 'string' ? {stringValue: v} : typeof v === 'boolean' ? {boolValue: v} : Number.isInteger(v) ? {intValue: String(v)} : {doubleValue: v}}];

export type TurnInfo = {ref?: ModelRef; startedAt: number; endedAt: number; interrupted: boolean; tokens: TokenCount; sessionId?: string};

export class Telemetry {
  private tools = new Map<number, {label: string; started: number; agent?: string}>();
  private done: {label: string; started: number; ended: number; ok: boolean; agent?: string}[] = [];
  /** Exports in flight, so shutdown can wait for them briefly. */
  private pending = new Set<Promise<void>>();

  constructor(private readonly config: () => Config, private readonly post: (url: string, body: unknown, headers: Record<string, string>) => Promise<void> = postJson) {}

  private settings(): (OtelConfig & {endpoint: string}) | undefined {
    const o = this.config().otel;
    const endpoint = (o?.endpoint ?? (o ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT : undefined))?.replace(/\/+$/, '');
    return o && endpoint ? {...o, endpoint} : undefined;
  }

  /** The tool host's activity feed: tool calls between a turn's start and end become its child spans. */
  activity(a: ToolActivity): void {
    if (!this.settings()) return;
    if (a.phase === 'start') this.tools.set(a.id, {label: a.label, started: Date.now(), agent: a.origin?.name});
    else {
      const s = this.tools.get(a.id);
      this.tools.delete(a.id);
      if (s) this.done.push({...s, ended: Date.now(), ok: a.ok !== false});
    }
  }

  turnEnd(turn: TurnInfo): void {
    const o = this.settings();
    const tools = this.done;
    this.done = [];
    if (!o) return;
    const traceId = hex(16);
    const root = hex(8);
    const model = turn.ref ? `${turn.ref.provider}:${turn.ref.model}` : undefined;
    const spans: Span[] = [
      {
        traceId,
        spanId: root,
        name: 'rein.turn',
        kind: 1,
        startTimeUnixNano: nanos(turn.startedAt),
        endTimeUnixNano: nanos(turn.endedAt),
        attributes: [
          ...attr('rein.model', model),
          ...attr('rein.session_id', turn.sessionId),
          ...attr('rein.interrupted', turn.interrupted),
          ...attr('rein.tokens.input', turn.tokens.input),
          ...attr('rein.tokens.cached', turn.tokens.cached),
          ...attr('rein.tokens.output', turn.tokens.output),
          ...attr('rein.cost_usd', turn.tokens.usd),
          ...attr('rein.tool_calls', tools.length),
        ],
        status: {code: turn.interrupted ? 2 : 1},
      },
      ...tools.map((t) => ({
        traceId,
        spanId: hex(8),
        parentSpanId: root,
        name: 'rein.tool',
        kind: 1,
        startTimeUnixNano: nanos(t.started),
        endTimeUnixNano: nanos(t.ended),
        attributes: [...attr('rein.tool', t.label), ...attr('rein.ok', t.ok), ...attr('rein.subagent', t.agent)],
        status: {code: t.ok ? 1 : 2},
      })),
    ];
    const resource = {attributes: attr('service.name', o.serviceName ?? 'rein')};
    const scope = {name: 'rein-harness'};
    const now = nanos(turn.endedAt);
    const sum = (name: string, unit: string, points: {value: number; attrs: Attr[]}[]) => ({
      name,
      unit,
      sum: {aggregationTemporality: 1, isMonotonic: true, dataPoints: points.map((p) => ({startTimeUnixNano: nanos(turn.startedAt), timeUnixNano: now, attributes: p.attrs, ...(Number.isInteger(p.value) ? {asInt: String(p.value)} : {asDouble: p.value})}))},
    });
    const m = attr('rein.model', model);
    const metrics = [
      sum('rein.tokens', '{token}', [
        {value: turn.tokens.input - turn.tokens.cached, attrs: [...m, ...attr('rein.type', 'uncached')]},
        {value: turn.tokens.cached, attrs: [...m, ...attr('rein.type', 'cached')]},
        {value: turn.tokens.output, attrs: [...m, ...attr('rein.type', 'output')]},
      ]),
      sum('rein.turns', '{turn}', [{value: 1, attrs: m}]),
      sum('rein.tool_calls', '{call}', [{value: tools.length, attrs: m}]),
      ...(turn.tokens.usd !== undefined ? [sum('rein.cost', 'USD', [{value: turn.tokens.usd, attrs: m}])] : []),
    ];
    const headers = o.headers ?? {};
    this.track(this.post(`${o.endpoint}/v1/traces`, {resourceSpans: [{resource, scopeSpans: [{scope, spans}]}]}, headers));
    this.track(this.post(`${o.endpoint}/v1/metrics`, {resourceMetrics: [{resource, scopeMetrics: [{scope, metrics}]}]}, headers));
  }

  private track(p: Promise<void>): void {
    const q = p.catch(() => {}).finally(() => this.pending.delete(q)); // a collector being down never breaks a session
    this.pending.add(q);
  }

  /** Wait (briefly) for exports still in flight, e.g. before `rein -p` exits. */
  async flush(timeoutMs = 2000): Promise<void> {
    await Promise.race([Promise.all([...this.pending]), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<void> {
  await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)});
}
