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

## Related

- [Cost & budgets](../cost/): what a conversation costs, and caps
- [Routing](../routing/): how auto mode picks a model
