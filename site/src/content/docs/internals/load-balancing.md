---
title: Load balancing
description: How Rein spreads work across your subscriptions with a time-weighted "use it or lose it" score, and moves a conversation to another account only when the prompt cache is already gone or the account is about to hit its limit.
---

With two Claude subscriptions (or a Claude and a Codex account offering the same kind of model), Rein uses all of them, and it does it without throwing away prompt caches. New conversations and subagents start on the account with the most usable room. An ongoing conversation stays put while its cache is warm and moves only when moving costs nothing, or when staying would mean hitting a wall.

```text title="rein"
  Load balancing: switching to Claude Account 2 (cache was cold; balance score 91 vs 48)
  → Sonnet · Claude Account 2 (auto · 0.88)
```

## The balance score

Every account gets a score from 0 to 100, higher meaning better to use now. `balanceScore()` in `src/store/usage.ts`:

```ts
// per live usage window (5h, weekly, 30-day…):
real = 100 - usedPct
if (real < DANGER_HEADROOM) return real          // within 10% of a limit: no discount
left = (resetsAt - now) / windowLength            // share of the window still to run, 0..1
return 100 - usedPct * left
// score = the minimum over all windows (the tightest one decides)
```

Usage counts **in proportion to the time left before it resets**, which is "use it or lose it". Capacity that's about to reset is nearly free, so Rein should burn it before it vanishes:

| Window | Used | Time left | Contribution |
| --- | --- | --- | --- |
| 5-hour | 80% | 10 min of 300 | `100 − 80 × 0.033` ≈ **97** |
| weekly | 60% | 6 days of 7 | `100 − 60 × 0.857` ≈ **49** |

That account scores 49. The weekly window is the real pressure. The nearly-full 5-hour window resets in ten minutes, so it barely counts.

Then `ModelCatalog.score()` in `src/router/catalog.ts` subtracts **`BUSY_PENALTY` = 15 points per live session** already on the account (main chat or subagent, counted by `catalog.track()`). Ten parallel subagents fan out across your accounts instead of piling onto the one that looked best a second ago.

Some edge values:

- **No usage data yet:** `balanceScore` = 70 (`UNKNOWN_SCORE`), which is worth trying, since the first request brings data. The separate `headroom()` function, used for health and danger checks, treats unknown as 50.
- **Every window has reset:** 100.
- **Exhausted or cooling down:** not a candidate at all.

## Which accounts are eligible

`ModelCatalog.healthyAccounts()` keeps an account only if:

- it offers the model (Codex model lists differ by plan),
- it isn't on **cooldown** (after a limit error, until the reset time, or 15 minutes when none is known),
- it hasn't failed auth this run (`authFailed`, cleared when the catalog refreshes after `/login`),
- it isn't being removed (`retired`),
- its headroom is above `100 − maxUsedPct`. With the default `maxUsedPct: 98`, an account at 98% counts as exhausted.

Survivors are sorted by score, best first.

## When a conversation switches accounts

`Engine.pickAccount()` in `src/session/engine.ts` runs before every attempt. It's a short, strict decision list, and the order is the clever part:

1. **No account yet** (new conversation), or the conversation's account is no longer healthy or was removed: take the best one. A removed account shows `Continuing on Claude Account 2 (the previous account was removed)`.
2. **The best account is the current one**, or `loadBalancing` is `sticky`: stay.
3. **Danger:** the current account has less than **10% real headroom** (`DANGER_HEADROOM`). Switch now, before the provider rejects a request mid-task: `Load balancing: Claude Account 1 is near its limit — switching to Claude Account 2 before it's rejected`.
4. **Cache warm:** if the conversation used this account less than **60 minutes** ago (`CACHE_WARM_MS`) and hasn't been compacted since, stay. A warm prompt cache is worth more than a better score.
5. **Not clearly better:** if the best account's score beats the current one by less than **15 points** (`BALANCE_MARGIN`), stay. The current account's score gets its own live session's 15-point penalty added back, so the conversation isn't judged against itself. This margin stops flip-flopping between two similar accounts.
6. **Carry would force a compaction:** if replaying the part of the conversation the other account hasn't seen would exceed the 24k-token carry budget (`CARRY_BUDGET_TOKENS`), stay. Moving isn't worth summarizing your history.
7. Otherwise switch: `Load balancing: switching to … (cache was cold; balance score 91 vs 48)`, or `(after compaction; …)`.

Steps 4–6 boil down to one rule: **a balanced move happens only at a moment when the cache is already lost**. That's either after a compaction, which rebuilds the history anyway, or after an hour idle, when the provider has dropped the cache. When the move happens, the new session gets the history through a [context carry](../context/).

Hard failures skip the list entirely. A `limit`, `auth` or `overloaded` error excludes that account for the rest of the turn and the engine retries on the next one, up to 5 attempts. If no account for the model is left, Rein fails over to another model. See [Accounts](../../features/accounts/).

### Who doesn't move

- **Forks stay on the parent's account.** `/btw` and fork-mode subagents branch the parent's native session, which only exists on that account.
- **New-mode subagents** start on the best-scoring account at spawn time, penalties included.
- Utility calls (decider, compactor, web, advisor) use the best healthy account for their model each time.

## Measured cache lifetimes

The 60-minute warm window wasn't guessed. It was measured through Rein's own sessions with a ~13k-token prefix and a second request after a gap (PLAN.md §22):

| Gap | Claude cached | Codex cached |
| --- | --- | --- |
| 4 min | 99% | 93–98% |
| 8 min | 99% | 93–98% |
| 16 min | n/a | 93–98% |
| 31 min | 99% | 93–98% |
| 58 min | 99% | n/a |
| 61 min | n/a | 93–98% |
| 65 min | **0%** | n/a |

Claude writes `ephemeral_1h` cache entries, so the cliff sits just past an hour. Codex was still at 94% after 61 minutes. `CACHE_WARM_MS` is 60 minutes for both providers. (A 5-minute fallback exists only for an unknown provider.)

The same reasoning drives auto effort: changing effort invalidates the cache, so `effortFor()` asks the decision model for a new level only when the cache is cold, and a warm session keeps its effort.

## Keeping usage fresh

Balancing is only as good as its numbers, and the two providers differ sharply:

- **Codex** usage is free to read (`account/rateLimits/read`) and also pushed with `account/rateLimits/updated` during turns.
- **Claude** only reports usage alongside a request, through the `rate_limit_event` on a process's first request. Reading it costs a tiny one-shot on the account's cheapest model.

`startUsageRefresh()` in `src/accounts/usage.ts` runs in the background: the first tick 20 s after launch, then every 10 minutes.

| Provider | Refreshed when |
| --- | --- |
| Codex | the reading is older than 10 minutes (free) |
| Claude | you have **more than one** Claude account, the account has **no live session**, and the reading is **over an hour** old |

The refresher does nothing in `sticky` mode, and `REIN_NO_USAGE_REFRESH` disables it. Claude accounts in active use need no pings, since their sessions report usage as they go.

`/usage` reads Codex live and refreshes a Claude account when its reading is more than 10 minutes old (`CLAUDE_STALE_MS`). `/usage refresh` forces a fresh reading for every account. Snapshots and cooldowns persist in `~/.rein/state/usage.json`, so a restart doesn't forget that an account is cooling down.

## Sticky mode

`/configure` → **Load balancing** → **Sticky** (`"loadBalancing": "sticky"`) restores the simple behaviour. A conversation stays on its account until that account is unhealthy, meaning rejected, on cooldown or past `maxUsedPct`. New conversations and subagents still start on the best-scoring account, because `healthyAccounts()` always sorts by score. Only the mid-conversation moves and the background refresher are switched off.

:::note
The **Load balancing** tab's description says a conversation moves when its cache "has gone cold (idle 5+ min)". The code uses 60 minutes, based on the measurements above.
:::

## Tuning

Every number on this page is a named constant, ready for a pull request with better measurements:

| Constant | Value | File |
| --- | --- | --- |
| `DANGER_HEADROOM` | 10 | `src/store/usage.ts` |
| `UNKNOWN_SCORE` | 70 | `src/store/usage.ts` |
| `BUSY_PENALTY` | 15 | `src/router/catalog.ts` |
| `BALANCE_MARGIN` | 15 | `src/session/engine.ts` |
| `CACHE_WARM_MS` | 60 min (both) | `src/session/engine.ts` |
| `CARRY_BUDGET_TOKENS` | 24,000 | `src/session/engine.ts` |
| `MAX_ATTEMPTS` | 5 | `src/session/engine.ts` |
| `CLAUDE_STALE_MS` | 10 min | `src/accounts/usage.ts` |
| `CLAUDE_IDLE_REFRESH_MS` | 60 min | `src/accounts/usage.ts` |
| `maxUsedPct` | 98 (config) | `~/.rein/config.json` |

## Related

- [Accounts](../../features/accounts/): adding accounts, failover, `/usage`
- [Context](../context/): what a switch carries over
- [Drivers](../drivers/): where usage readings come from
- [Configuration](../../reference/configuration/): `loadBalancing`, `maxUsedPct`
