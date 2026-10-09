---
title: Insight
description: What your own history says about how the agent works for you. Request analytics from saved conversations, prompt-cache hit rates, and benchmarks on your own repos.
---

Rein keeps every conversation on your machine. That's enough to answer practical questions: how long a request usually takes, how often the tests pass at the end, which model does better on your code, and what each request costs. Nothing on this page sends anything anywhere.

## How your requests go

`/stats` reads the conversations saved for this project over the last 30 days:

```text title="rein"
> /stats
  ⎿ Last 30 days, shop: 41 conversations, 212 requests
      time per request   median 3 min · longest 1.4 h
      tool calls         3,180 (15.0 a request) · 6% failed · 74 retries of a failed call
      tests at the end   passed in 121 of 139 requests that ran tests (87%)
      interrupted        9 requests
      cost               $96.30 at API list prices ($0.45 a request)
    By model:
      claude:opus                  118 requests, median 4 min, 18.2 tool calls each, tests passed at the end 91% (of 84 tested), $0.61 a request
      codex:gpt-5.5                 71 requests, median 2 min, 11.0 tool calls each, tests passed at the end 82% (of 45 tested), $0.27 a request
```

A **request** is one message from you and everything the agent did until your next one. Rein's own follow-ups, like the end-of-turn code check, count as part of it. For each request:

- **Time** runs from your message to the agent's last reply.
- **Failed** counts tool calls that returned an error.
- **Retry** counts a failed call that the agent made again unchanged later in the same request.
- **Tests at the end** looks at the last test command the agent ran (npm test, pytest, go test, cargo test…). It's counted only for requests that ran tests.
- **Interrupted** counts requests you stopped, or that were cut off.
- **Cost** is at API list prices, as in [`/cost`](../cost/). Per-message cost isn't saved, so each request gets an even share of its conversation's cost.
- **By model** groups requests by the model that gave the last reply.

`/stats 90` looks back 90 days, and `/stats all` covers every project. These are your numbers on your code, so they show which model and settings work for you better than a public benchmark would.

## The prompt cache

Most of a turn's input is the same as the last turn's: the system prompt, the tools, the conversation so far. Providers cache that prefix, and a cached token costs a fraction of an uncached one and comes back faster. `/cache` shows how much of your input came from the cache and what made it miss:

```text title="rein"
> /cache
  ⎿ Prompt cache, last 30 days (shop): 91% of 48.2M input tokens read from the cache, over 1,906 turns
    By model:
      claude:opus                  93% cached · 1,204 turns
      codex:gpt-5.5                88% cached · 702 turns
    What made it cold (turns, input tokens not cached):
      compacted                                      31 turns    1.9M
      idle (past the cache lifetime)                 22 turns    1.2M
      switched account                               14 turns    610K
      first message                                  41 turns    380K
      new native session (context carried over)       6 turns    240K
```

For every reply, Rein records the turn's input tokens, how many were cached, and why the cache was cold when it knows:

| Reason | What happened |
| --- | --- |
| first message | A new conversation |
| compacted | `/compact` or auto-compaction replaced the history with a summary |
| rewound | [`/rewind`](../rewind/) cut the history |
| switched account / switched provider | [Load balancing or failover](../accounts/) moved the conversation |
| model changed | Same session, different model (each model has its own cache) |
| new native session (context carried over) | The CLI session couldn't be resumed, so the context was carried into a new one |
| idle N min (past the cache lifetime) | Longer than the cache lasts since the account's last turn |

A turn that read under half its input from the cache with none of these reasons shows as **unexplained**. That usually means the system prompt or tool list changed mid-conversation, or the provider evicted the cache early. The data is recorded from this version of Rein on, so older conversations don't count. `/cache 90` and `/cache all` work like `/stats`.

## Related

- [Cost & budgets](../cost/): what a conversation costs, and caps
- [Routing](../routing/): how auto mode picks a model
