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

## Benchmark on your own repo

Public benchmarks measure someone else's code. `rein bench` measures models and settings on yours, using changes your team already made:

```sh
rein bench init                      # pick 10 recent commits as tasks
rein bench run --model claude:opus --model codex:gpt-5.5
```

```text
Running 10 tasks × 2 models (real runs on your accounts)…
  3f9a21c0 claude:opus: passed (212s, $0.48)
  3f9a21c0 codex:gpt-5.5: failed (140s, $0.19)
  …
10 tasks from this repo's history:
  claude:opus                    8/10 passed (80%) · 231s a task · $0.52 a task
  codex:gpt-5.5                  6/10 passed (60%) · 162s a task · $0.21 a task
```

1. **Tasks.** `rein bench init` picks recent commits that change code *and* its tests (non-merge, under 400 lines), and saves them to `.rein/bench/tasks.json`. Each task is the commit message as the prompt, the code before the commit, and the commit's test files. Edit the file to drop tasks or reword prompts that only make sense with context.
2. **Runs.** For each task and model, Rein exports the code as it was before the commit into a fresh folder (`git archive`, so there's no history to read the answer from). It runs `rein -p` there with that model in bypass mode.
3. **Judging.** Then it puts in the commit's own test files, as they were after the commit, and runs the test command (detected like [`/bestof`](../subagents/#best-of-both-providers), or `--test "<cmd>"`). Passing those hidden tests means the task was done.

Results go to `.rein/bench/results/` with the time and cost of every run. `--tasks 3` runs only the first three, which is useful for trying it cheaply. Every run uses your accounts like any other, so a full run of 10 tasks on two models is 20 real agent runs.

## Onboarding tours

A new teammate's first week goes on finding the ten files that explain the rest. `/tour` writes that path down:

```text title="rein"
> /tour the orders service
```

The agent reads the README and instructions, finds the entry points, and follows one real request or job end to end. Then it picks **8 to 20 stops** in reading order:

1. What this is and how to run it.
2. The entry point.
3. Each layer the request passes through.
4. The core types and logic.
5. The data layer.
6. Config, auth, errors and logging.
7. Where the tests are and how to run one.
8. Who to ask (from [`/owners`](../large-codebases/#who-owns-what)).

Each stop is a real file and line it has checked, with a short paragraph on why it matters. It writes two files:

- **`.tours/<name>.tour`** in the [CodeTour](https://github.com/microsoft/codetour) format. With the CodeTour extension, VS Code plays it step by step, opening each file at its line.
- **`docs/tours/<name>.md`**: the same stops as a page with `path:line` links, for reading anywhere.

Commit them, and the next person who joins gets the tour.

## Related

- [Cost & budgets](../cost/): what a conversation costs, and caps
- [Routing](../routing/): how auto mode picks a model
