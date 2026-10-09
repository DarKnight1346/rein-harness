---
title: Observability
description: Send every turn, tool call, token count and cost to any OpenTelemetry backend (Grafana, Honeycomb, Datadog, Jaeger) as traces and metrics. Metadata only, off by default.
---

Rein can export what it does to any OpenTelemetry backend (Grafana, Honeycomb, Datadog, Jaeger, an OTel Collector) so you can watch agent work across sessions and machines: which models run, how long turns take, which tools fail, and what it costs.

It's **off** until you set an endpoint in `~/.rein/config.json`:

```json title="~/.rein/config.json"
{
  "otel": {
    "endpoint": "http://localhost:4318",
    "headers": {"authorization": "Bearer …"},
    "serviceName": "rein"
  }
}
```

- `endpoint`: an OTLP/HTTP endpoint. Rein posts JSON to `<endpoint>/v1/traces` and `<endpoint>/v1/metrics`. With `"otel": {}` and no endpoint, `OTEL_EXPORTER_OTLP_ENDPOINT` is used.
- `headers`: sent with every export (an API key for a hosted backend).
- `serviceName`: the `service.name` resource attribute. Default `rein`.

Interactive sessions and [`rein -p`](../headless/) both export. `rein -p` waits up to 2 seconds for exports to finish before it exits. A collector that's down or slow never affects the session: failed exports are dropped.

## What's sent

**Traces:** one trace per turn (each model reply, including Rein's own follow-ups).

| Span | Attributes |
|---|---|
| `rein.turn` | `rein.model` (`claude:opus`), `rein.session_id`, `rein.interrupted`, `rein.tokens.input`, `rein.tokens.cached`, `rein.tokens.output`, `rein.cost_usd`, `rein.tool_calls` |
| `rein.tool` (a child per tool call) | `rein.tool` (`Read`, `Shell`, `Edit`, …), `rein.ok`, `rein.subagent` (the subagent's name, for its calls) |

A failed tool call or an interrupted turn has an error status.

**Metrics** (cumulative sums per turn, with `rein.model`):

| Metric | Unit | Meaning |
|---|---|---|
| `rein.tokens` | tokens | By `rein.type`: `uncached`, `cached`, `output` |
| `rein.cost` | USD | At API list prices (see [Cost & budgets](../cost/)) |
| `rein.turns` | turns | Turns finished |
| `rein.tool_calls` | calls | Tool calls in those turns |

:::note[Metadata only]
Exports never contain prompts, replies, file names, file contents, commands or tool results: only model names, tool names, timings, outcomes, token counts and cost. The session id is Rein's own conversation id.
:::

## Related

- [Cost & budgets](../cost/): how cost is computed
- [Headless & CI](../headless/): exporting from CI runs
- [Configuration](../../reference/configuration/): `otel`
