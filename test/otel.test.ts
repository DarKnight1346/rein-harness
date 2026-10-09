import {afterEach, describe, expect, it} from 'vitest';
import {Telemetry} from '../src/telemetry/otel.js';

const env = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
afterEach(() => {
  if (env === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = env;
});

function telemetry(otel: object | undefined) {
  const sent: {url: string; body: any; headers: Record<string, string>}[] = [];
  const t = new Telemetry(() => ({otel}) as any, async (url, body, headers) => void sent.push({url, body, headers}));
  return {t, sent};
}

const turn = {ref: {provider: 'claude' as const, model: 'opus'}, startedAt: 1_000, endedAt: 4_000, interrupted: false, tokens: {input: 1200, cached: 1000, output: 50, usd: 0.0012}, sessionId: 's1'};

describe('OpenTelemetry export', () => {
  it('sends each turn as a trace with a span per tool call, and token/cost metrics', async () => {
    const {t, sent} = telemetry({endpoint: 'http://collector:4318/', headers: {authorization: 'Bearer x'}});
    t.activity({phase: 'start', id: 1, label: 'Read', summary: 'src/secret.ts'});
    t.activity({phase: 'end', id: 1, label: 'Read', summary: 'src/secret.ts', ok: true, result: 'const KEY = 1'});
    t.turnEnd(turn);
    await t.flush();
    expect(sent.map((s) => s.url)).toEqual(['http://collector:4318/v1/traces', 'http://collector:4318/v1/metrics']);
    expect(sent[0]!.headers).toEqual({authorization: 'Bearer x'});
    const spans = sent[0]!.body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s: any) => s.name)).toEqual(['rein.turn', 'rein.tool']);
    expect(spans[1].parentSpanId).toBe(spans[0].spanId);
    expect(spans[0].startTimeUnixNano).toBe('1000000000');
    const metrics = sent[1]!.body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: any) => m.name);
    expect(metrics).toEqual(['rein.tokens', 'rein.turns', 'rein.tool_calls', 'rein.cost']);
    // Metadata only: no file names, commands or content leave the machine.
    expect(JSON.stringify(sent)).not.toMatch(/secret|KEY/);
  });

  it('is off without an endpoint, and takes OTEL_EXPORTER_OTLP_ENDPOINT once otel is set', async () => {
    const off = telemetry(undefined);
    off.t.turnEnd(turn);
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env:4318';
    off.t.turnEnd(turn);
    expect(off.sent).toEqual([]);
    const on = telemetry({});
    on.t.turnEnd(turn);
    await on.t.flush();
    expect(on.sent[0]!.url).toBe('http://env:4318/v1/traces');
  });

  it("never breaks a session when the collector is down", async () => {
    const t = new Telemetry(() => ({otel: {endpoint: 'http://down'}}) as any, async () => {
      throw new Error('ECONNREFUSED');
    });
    t.turnEnd(turn);
    await expect(t.flush()).resolves.toBeUndefined();
  });
});
