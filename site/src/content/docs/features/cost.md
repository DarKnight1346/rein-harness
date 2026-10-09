---
title: Cost & budgets
description: What a conversation, a request and a goal cost in dollars at API list prices, and spending caps that stop the agent before it overruns them.
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

## Goal estimates

Rein records what each [goal](../goals/) cost when it's done. Once a project has at least 3 finished goals in its recent conversations (the last 50), `/goal` shows what goals there have cost:

```text title="rein"
> /goal migrate the billing service to the new queue
  ⎿ ◎ Goal set: migrate the billing service to the new queue
    …
    Goals here have cost $3.40 (median of the last 7; $0.90–$12.10, API prices).
```

With `goalConfirmUsd` set (USD, `0` = off, the default), a goal whose typical cost is above it isn't started right away: Rein shows the estimate and asks you to send the same `/goal` again to start it. Set it with `/settings goalConfirmUsd 5`.

It's a median of past goals in the same project, not a prediction for this one: a bigger goal can cost more.

## Budgets

Set spending caps, in USD at the same API list prices, and Rein stops the agent when one is reached:

```json title="~/.rein/config.json"
{
  "budget": {"requestUsd": 2, "goalUsd": 20, "conversationUsd": 50}
}
```

Or from the prompt: `/settings budget {"requestUsd": 2}`.

| Cap | Counts | When it's reached |
|---|---|---|
| `requestUsd` | Everything after one message of yours: the turn, Rein's follow-ups (code checks, Stop hooks), subagents and helper calls | The turn stops. Your next message starts a new request. |
| `goalUsd` | Everything since the current [goal](../goals/) was set | The turn stops and the goal is paused. `/goal resume` continues it, if you raise the cap first. |
| `conversationUsd` | The whole conversation | The turn stops, and new messages are refused until you raise the cap or start a new conversation (`/clear`). |

When a cap is reached, the turn stops as soon as the request that crossed it reports its tokens. You see `Budget reached: this request has cost $2.03 of its $2.00 budget (API list prices), so Rein stopped.` A request already running finishes the step it's on, so the spend can end slightly above the cap. In [`rein -p`](../headless/) a budget stop is an error (exit code `1`), with that message.

**Per repo:** a project's `.rein/settings.json` (or `.rein/settings.local.json`) can set its own `budget`. Where you and the repo both set the same cap, the lower one wins, so a repo can keep agents cheap without changing your other projects.

`/cost` lists the caps in force and how much of each is used:

```text
Budgets (config budget, or a lower one in .rein/settings.json):
  request budget     $0.83 of $2.00
  goal budget        $3.10 of $20.00
```

Budgets need prices: a model with no price ([see above](#how-its-priced)) isn't counted toward them.

## Related

- [Model routing](../routing/): choosing cheaper models automatically
- [Headless & CI](../headless/): `cost_usd` in JSON output
- [Configuration](../../reference/configuration/): `prices`
