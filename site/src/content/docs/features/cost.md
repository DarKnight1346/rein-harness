---
title: Cost & budgets
description: What a conversation, a request and a goal cost in dollars at API list prices, in the sidebar, /cost and rein -p output.
---

Rein prices every model request as it happens, so you can see what work costs in dollars, not just tokens:

```text title="rein"
> /cost
  ⎿ At API list prices (a subscription isn't billed per token; this is what the same tokens would cost on the API):
      this conversation  $4.12  (uncached 412K · cached 18.3M · received 96K)
      latest request     $0.83
      goal so far        $3.10  (active)
    Includes subagents and helper calls (compaction, decisions, the advisor).
```

- **The sidebar's Session section** shows the conversation's total as `cost ≈$4.12`. Click it for `/cost`.
- **`rein -p`** adds `cost_usd` to its JSON result, and `tokens.usd` to the running totals (see [Headless & CI](../headless/)).
- **`/cost`** shows the conversation, the latest request (everything since your last message, including Rein's own follow-ups) and the current [goal](../goals/) since it was set.

## How it's priced

Each API request is priced on its own, from the token counts the CLI reports:

- plain input at the model's input price;
- cache hits at its cache-hit price;
- cache writes at its 1-hour cache-write price, which is what Claude Code writes on a subscription. With the `cache-5m` [experiment](../../reference/configuration/#experiments) (on by default in `rein -p`), the 5-minute price is used instead;
- output, thinking included, at its output price.

A request whose prompt is over the model's long-context threshold pays the higher price for the whole request: Haiku 5.5 above 100,000 tokens, and OpenAI models above 272,000 tokens. Prices are the published API list prices for Claude and OpenAI models, built into Rein.

:::note
On a Claude or ChatGPT subscription nothing is billed per token. The figure is what the same tokens would cost on the API: useful for comparing models and settings, and what an API-key account would pay.
:::

**A model with no built-in price** (a new or custom one) is counted in tokens only, and `/cost` says so. Add its price under `prices` in `~/.rein/config.json`, in USD per million tokens:

```json title="~/.rein/config.json"
{
  "prices": {
    "codex:my-model": {"input": 1.5, "cached": 0.15, "output": 6}
  }
}
```

`write5m` and `write1h` (cache writes) default to the input price. An entry for a model that has a built-in price replaces it.

Conversations from before this feature have no saved cost: their total counts from the first request priced after you resume them.

## Related

- [Model routing](../routing/): choosing cheaper models automatically
- [Headless & CI](../headless/): `cost_usd` in JSON output
- [Configuration](../../reference/configuration/): `prices`
