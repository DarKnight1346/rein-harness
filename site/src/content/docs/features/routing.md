---
title: Models & routing
description: Pick one model or let Rein route every message to the cheapest model that will answer it well, with effort, decision, compaction, advisor, web and subagent models set in one screen.
---

Pin one model or set the chat model to `auto`. On `auto`, Rein looks at each new message and sends it to the **cheapest model across all your signed-in Claude and Codex accounts that will answer it well**. Quick questions go to a fast, cheap model. A gnarly refactor goes to a frontier one. Once a task is under way, Rein doesn't switch models mid-task without a good reason.

## Quick example

```text title="rein"
> /model auto
Chat model: auto

> what does the -z flag do in grep?
  → Haiku · Claude Account 1 (auto · 0.91)

> ok, now refactor src/session/engine.ts so the retry loop is testable
  → Opus · Claude Account 2 (auto · 0.83)

> also add a test for the 5-attempt limit
  → Opus · Claude Account 2 (auto · stayed)
```

The dim `→` line under each message is the route. It shows the model, the effort (when one was set), the account that served the turn, and why that model was picked:

| Suffix | Meaning |
| --- | --- |
| `(auto · 0.91)` | Auto routing picked this model with confidence 0.91 |
| `(auto · stayed)` | Mid-conversation: the decider judged this a continuation, so the current model kept it |
| `(default)` | Auto wasn't confident enough (or no model is pinned), so the default model answered |
| `(failover)` | Every account for the chosen model was unavailable, so Rein moved to another model |
| *(none)* | You pinned this model |

## The `/model` screen

`/model` opens a window with seven tabs. Switch tabs with click, `←` `→` or `Tab`. Choose with `↑` `↓` and `Enter`. Close with `Esc`.

| Tab | Config key | What it controls | Default |
| --- | --- | --- | --- |
| **Chat model** | `chatModel` | The model that answers you: `auto` or any signed-in model. After you choose, an effort picker opens. | The provider default |
| **Subagents** | `subagentModel` | Your model for new-mode subagents (`auto` = none of your own) | `auto` |
| **Subagent priority** | `subagentPriority` | Whose pick wins for new subagents: yours or the agent's | `user` |
| **Decision model** | `decisionModel` | Routes `auto`, picks failover models and answers Rein's other yes/no checks | `cheapest` |
| **Compaction model** | `compactionModel` | Summarizes the conversation for `/compact`, long chats and handoffs between models | `cheapest` |
| **Advisor** | `advisorModel` | A stronger model agents can consult through the `advisor` tool | `off` |
| **Web** | `webModel` | Runs `web_search` with its provider's built-in search, and reads fetched pages for `web_fetch` | `cheapest` |

The model list is the union of every model offered by every account you've added. Claude models come from the `claude` CLI's own model list (cached for 24 hours per account). Codex models come from each account's `model/list`, because plans differ. Internally a model is a ref like `claude:sonnet` or `codex:<model-id>`.

You can also skip the window:

```text title="rein"
> /model sonnet
Chat model: Sonnet
```

`/model <name>` accepts `auto`, a full ref, a model id, or a display label (case-insensitive). If nothing matches you get `Unknown model "…". Try /model to pick from the list.`

:::note
If you've never picked a chat model, Rein uses the **provider default**, which is not `auto`. That default is Claude's own default model if you have any Claude account, otherwise the model Codex flags as its default. Turn on routing with `/model auto`.
:::

## Pinned vs auto

- **Pinned** (`/model sonnet`): every message goes to that model. Rein still spreads the work across your accounts and fails over when one hits a limit (see [Accounts](../accounts/)). No decider call is made.
- **Auto** (`/model auto`): one decision-model call per message picks the model. The top bar shows `auto · Sonnet` (the model currently in use), and the sidebar's **Auto routing** section shows the last decision, e.g. `claude:haiku (0.91) via jev` or `stay (switch 0.12) via jev`.

While a message is being routed, the working indicator reads `Routing…` instead of `Thinking…`.

## How auto picks

Auto routing is built to stay cheap, fast and predictable. Each step in `src/router/auto.ts` cuts cost or bias:

1. **Filter in code first.** Candidates are models with at least one *healthy* account: not cooling down after a rate limit, not failing auth, not being removed, and under the used-% ceiling (`maxUsedPct`, default 98). If only one candidate is left, it's used with no decider call at all.
2. **One question, shuffled.** The decider gets a single `choice` question: *"Which model should answer the new message? Pick the cheapest model that will answer it well; reserve expensive models for genuinely hard reasoning, large code or high-stakes work."* Each option has the model's own description from its CLI plus a cost word (`very low` … `highest`). The **option order is shuffled on every call** to cancel first-option bias.
3. **A sticky switch question.** Mid-conversation (the current model is still available and this isn't your first message), a second yes/no question is added: *does the new message start a materially different kind of task?* If the probability is below `autoSwitchThreshold` (default **0.7**), Rein stays on the current model and its warm prompt cache. That's the `(auto · stayed)` route.
4. **Confidence fallback.** If the decider's confidence in its pick is below `autoMinConfidence` (default **0.45**), or it names an unknown model, Rein uses the default model instead (`defaultModel`, or the provider default).

:::tip[The decider never sees your transcript]
The decider gets only the new message, trimmed to its first 3,600 and last 2,400 characters (about 1.5k tokens). Mid-conversation it also gets the current model's name, a short tag for the current task and the turn number. Your conversation history never leaves the chat session, so a routing decision costs almost nothing no matter how long the chat gets.
:::

Cost tiers (1 = cheapest … 6 = most expensive) are inferred from how each CLI *describes* its models. Neither CLI exposes prices. "Fastest", "affordable" or "mini" reads as tier 1, "frontier" or "most capable" as tier 6, "everyday" or "workhorse" as tier 4, and so on.

### When a model runs out

If every account for the routed model is limited, Rein needs a replacement:

- On **auto**, it re-runs the auto router without the failed model.
- On a **pinned** model, it takes the healthy model closest in cost tier, preferring the stronger one on a tie. No tokens are spent deciding.

```text title="rein"
  No Opus account available — switching to Sonnet
  → Sonnet · Claude Account 1 (failover)
```

The full failover and load-balancing story is on [Accounts](../accounts/) and [Load balancing](../../internals/load-balancing/).

## Effort

After you choose a chat model, `/model` asks for its effort:

```text title="rein"
Effort for Opus
How hard the model thinks. Changing it mid-conversation discards the prompt cache, so auto only changes it when the cache is cold anyway.

❯ ● Auto           the decision model picks per task (when the cache is cold)
  ○ Model default  currently high
  ○ low            fastest, cheapest
  ○ medium         balanced
  ○ high           harder problems
  ○ xhigh          very hard problems
  ○ max            may use excessive tokens — hardest tasks only
```

The levels listed are the ones that model reports supporting. Codex models may also offer `ultra` (maximum reasoning). The setting is stored as `chatEffort`, default `auto`.

- **A fixed level** is clamped to what the current model supports. If you pick `xhigh` and a model tops out at `high`, it gets `high`.
- **Model default** leaves effort unset, so the CLI uses its own default.
- **Auto** asks the decision model one question: is this a simple message (a lookup, a small mechanical edit)? If so it runs at `low`; otherwise effort is left at the **model's own default**. A message longer than about 2,000 characters always gets the model's default without asking: a long message is a spec, not a quick question. Rein's own follow-ups to your request (the continuation after a compaction, the code check, Stop hooks) keep the effort chosen for the request: they're short, but they aren't a new, simple message. Auto only ever lowers effort. Raising it for hard-looking requests was measured on hard coding tasks: `high` and `xhigh` doubled output and time without solving more tasks than the model's default.

The clever part is *when* auto effort runs. Changing effort mid-conversation throws away the provider's prompt cache. So auto effort only decides when the cache is **already cold**: a new session, a different account, after compaction, or after an hour idle (Rein measured both providers keeping caches warm for about 60 minutes). While the session is warm, it keeps its current effort.

On Codex, effort is set per turn. On Claude it's fixed per process, so Rein reopens the session with `--resume` (same history) when effort changes.

## The decision model

One small model answers all of Rein's quick judgment calls: auto routing, auto effort, failover in auto mode, auto-approvals, plan-mode shell checks, subagent completion checks, goal verification and the agent's `decide` tool. Choose it in **/model → Decision model**:

| Option | What it does |
| --- | --- |
| **Jev** | [typesafe.ai](https://typesafe.ai)'s decision API: fast and nearly free. Add a key in `/login` first. The option stays greyed out until you do. |
| **Cheapest available** *(default)* | The lowest-cost-tier model with a healthy account, run in a fresh one-shot process with a strict JSON-only prompt and minimal thinking. |
| A specific model | Any signed-in model, same strict prompt |

Adding a Jev key doesn't switch the decision model by itself. Choose **Jev** in this tab. Jev requests time out after 8 seconds (with retries on transient errors), and **any Jev failure falls back to the LLM decider**, so routing never blocks on Jev. The status bar's optional `decides:` segment shows which one is active. See [Decision model](../../internals/decision-model/) for the question format and every threshold.

## The other model roles

- **Compaction model** (`cheapest`): writes the structured summary when you run `/compact`, when context passes `autoCompactPct` (between turns or mid-turn), and when a conversation hands off to a different model or account. See [Context](../../internals/context/).
- **Advisor** (`off`): when set, the main agent and subagents get an `advisor` tool that sends one call to the stronger model, with about 40k tokens of recent conversation plus their question. It is **never auto**, because it's meant to be the expensive one. The list puts the most capable models first. Goals escalate to it when the agent is stuck (see [Goals](../goals/)).
- **Web** (`cheapest`): runs `web_search` through its provider's server-side search, and answers `web_fetch` prompts about long pages. Any signed-in Claude or Codex model works, whatever your chat model is. See [Web & images](../web-and-images/).
- **Subagents** and **Subagent priority**: decide which model a *new*-mode subagent gets. With **Your model first** (default) the order is your Subagents model → the agent's own pick → auto. With **Agent's choice first** it's the agent's pick → your model → auto. `auto` here means the same auto router picks from the subagent's task. **Forked subagents always keep the parent's model and account.** See [Subagents](../subagents/).

"Cheapest available" is resolved again at every use: the lowest cost tier with a healthy account, ties broken by the most headroom. If you pin a utility model whose accounts are all limited, Rein falls back to the cheapest available model.

## Configuration reference

All of these live in `~/.rein/config.json`. The `/model` screen writes the first eight. The routing thresholds can only be set in the file.

```json title="~/.rein/config.json"
{
  "chatModel": "auto",
  "chatEffort": "auto",
  "decisionModel": "jev",
  "compactionModel": "cheapest",
  "advisorModel": "claude:opus",
  "webModel": "cheapest",
  "subagentModel": "auto",
  "subagentPriority": "user",
  "defaultModel": "claude:sonnet",
  "autoSwitchThreshold": 0.7,
  "autoMinConfidence": 0.45,
  "maxUsedPct": 98
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `chatModel` | *unset* (provider default) | `auto` or a model ref |
| `chatEffort` | `auto` | `auto`, `default`, or a level |
| `defaultModel` | *unset* | Used when auto isn't confident, and as the chat model when none is set |
| `autoSwitchThreshold` | `0.7` | Switch models mid-conversation only when P(new kind of task) ≥ this |
| `autoMinConfidence` | `0.45` | Below this confidence, use the default model |
| `maxUsedPct` | `98` | An account counts as exhausted at this used % |

For headless runs, `rein -p --model <ref> --effort <level>` overrides the chat model and effort for that run (see [Headless](../headless/)).

## Gotchas

- **Auto costs one small decider call per message.** Jev is the fastest option. A cheap LLM decider adds a CLI round-trip before the reply starts. With only one available model, the call is skipped.
- **Stickiness is deliberate.** If you want a stronger model for a follow-up that looks like a continuation, pin it with `/model <name>` or phrase the message as a new task.
- **`/model` while viewing a subagent** changes the *main* agent's chat model. The subagent keeps its own.
- **Effort needs a model that supports it.** If a model reports no effort levels, the effort setting is ignored for it.

## Related

- [Accounts](../accounts/): multiple subscriptions, usage windows and failover
- [Load balancing](../../internals/load-balancing/): how an account is chosen for each turn
- [Decision model](../../internals/decision-model/): every question Rein asks it
- [Subagents](../subagents/) · [Goals](../goals/) · [Web & images](../web-and-images/)
- [Commands reference](../../reference/commands/) · [Configuration reference](../../reference/configuration/)
