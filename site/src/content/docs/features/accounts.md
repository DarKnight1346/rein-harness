---
title: Accounts & usage
description: Sign in to several Claude and Codex subscriptions, see every usage window at a glance, and let Rein fail over or rebalance when one runs low.
---

Rein treats your subscriptions as one pool. Sign in to as many Claude and Codex accounts as you have, and
Rein picks a healthy one for each turn. When an account hits its limit mid-reply, Rein retries the turn on the
next one, and you don't have to do anything.

## Quick look

Your first launch finds the logins you already have:

```text title="rein"
Found existing logins

  Claude Claude Account 1 · max
  Codex  Codex Account 1 · plus

Rein uses them in place (nothing is copied) and never logs them out.
Import? (Y/n)
```

Later, `/usage` shows every window for every account:

```text title="/usage"
  Claude Claude Account 1 · max
    5h     ████████████░░░░░░░░  61%  resets 4:10 PM (in 1h 52m)
    weekly ████░░░░░░░░░░░░░░░░  22%  resets Mon, Oct 6 9:00 AM (in 2d 16h)
    updated 3m ago

  Claude Claude Account 2 · pro · limited until 5:30 PM
    5h     ████████████████████ 100%  resets 5:30 PM (in 3h 12m)
    updated just now

  Codex Codex Account 1 · plus
    5h     ██░░░░░░░░░░░░░░░░░░   9%  resets 6:45 PM (in 4h 27m)
    weekly ███████░░░░░░░░░░░░░  35%  resets Thu, Oct 9 8:00 AM (in 5d 15h)
    updated just now

  Jev: API key set · /usage refresh re-checks Claude
```

And if an account runs out partway through a reply, the conversation keeps going:

```text title="rein"
  Claude Account 2 hit its limit (resets 5:30 PM) — retrying
  (partial reply discarded)
  → Sonnet · Claude Account 1 (auto · 0.86)
```

## Importing the logins you already have

On first launch Rein checks whether `claude` and `codex` are signed in with their normal config dirs
(`~/.claude`, `~/.codex`). It lists the ones that are, with each plan, and asks once. Your answer is
saved, so Rein won't ask again. If you skip, Rein prints `Skipped import. Use /login to add accounts.`

An imported login is used **in place**:

- Nothing is copied. Rein runs the CLI with its default config dir, the same one you use outside Rein.
- Rein **never logs it out** and never deletes its directory. The auth code refuses outright:
  `refusing to log out an imported login; unregister it instead`.
- Imported accounts show up as `imported` in `/login`.

## Adding more accounts with `/login`

`/login` opens the Accounts window. It lists every registered account with its plan and a live status
(`● signed in` / `● signed out`), followed by `+ Add Claude account`, `+ Add Codex account` and the Jev key row.

```text title="/login"
❯ Claude Claude Account 1 · max · imported  ● signed in
  Codex  Codex Account 1 · plus · imported  ● signed in
  + Add Claude account
  + Add Codex account
  + Add Jev API key (decisions)

click or ↑↓ select · enter open · esc close
```

Each provider signs in its own way, and Rein drives the official CLI for both:

| | Claude | Codex |
|---|---|---|
| Runs | `claude auth login --claudeai` | `codex app-server` → `account/login/start` (ChatGPT) |
| Browser | Claude opens it; Rein also shows the URL under `If the browser didn't open, visit:` | Rein opens it and shows the URL |
| Finishing | Paste the code from the browser at the `Code:` prompt (`paste the code and press enter · esc cancels`) | Automatic, through a localhost callback (`waiting for browser… · esc cancels`) |

When it works you'll see `Added Claude account Claude Account 2 (max)`. Press Esc while it's waiting to
cancel, and Rein deletes the half-made account folder.

:::note[Codex signs in with ChatGPT only]
Rein uses Codex's ChatGPT login. A Codex login of any other type reports `unsupported auth type` and is
treated as signed out.
:::

### Every account gets its own CLI home

New accounts are named `claude-1`, `claude-2`, `codex-1` and so on. Each one gets a private config dir
at `~/.rein/accounts/<provider>/<id>/`, created with mode `0700`. Rein points the CLI at it through
`CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so the logins never see each other and your own `~/.claude` stays
as it is.

Rein also strips credentials from the child process's environment that would override the account's
subscription login: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` for Claude,
`CODEX_API_KEY`, `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` for Codex. Rein never reads OAuth tokens
itself. The CLIs keep their own credentials.

### The same login can't be added twice

Two "accounts" on the same login would split one quota and look like double the capacity. So when a new
login comes back with an email that's already registered for that provider, Rein logs the new copy out,
deletes its folder and tells you which account already has it (the email shows as an account name
while privacy mode is on):

```text title="rein"
Claude Account 1 is already registered as claude-default
```

### Re-authenticate and remove

Pick an account in `/login` to get **Re-authenticate**, **Log out & remove** (Rein-added accounts) or
**Remove from Rein** (imported ones), and **Back**.

- **Re-authenticate** runs the login again in the same folder, for example after a token expires. On an
  imported account Rein asks first, because signing in there also signs in your normal CLI:
  `This signs in your normal Claude CLI login too. (y/n)`.
- **Removing** takes effect immediately. The account stops being picked for new work and drops out of
  `/login`, `/usage` and the model lists. Any session still running on it finishes first. Then Rein-added
  accounts are logged out and their folder is deleted (Rein only deletes folders under `~/.rein/accounts/`).
  Imported accounts are only unregistered: `Removed Claude Account 1 (unregistered; your CLI login is untouched)`.
- A conversation that was on the removed account moves to the best remaining one with its context
  carried over: `Continuing on Claude Account 2 (the previous account was removed)`.

## The Jev API key

The last row in `/login` stores an API key for [Jev](https://typesafe.ai), a fast decision model you can
choose for routing and approval decisions in [`/model`](../routing/). Rein checks the key before saving it,
then stores it in the safest place available:

1. The `TYPESAFE_API_KEY` environment variable, if set, always wins.
2. **macOS**: the Keychain, as service `rein-jev-api-key`.
3. **Windows**: a file in `~/.rein/secrets/` encrypted with DPAPI, so only your Windows user can decrypt it.
4. Elsewhere: `~/.rein/secrets/jev.key` with mode `0600`.

Saving the key doesn't switch anything on. Afterwards you pick Jev as the decision model in `/model`. If you
remove the key, decisions go to the cheapest model: `Jev key removed. Decisions fall back to the cheapest model.`

## Usage windows

`/usage` prints one block per account: each limit window as a bar (green, then yellow from 70%, red from 90%),
the percent used, and when it resets. Rein labels the windows by their length, so you see `5h`, `weekly` and
`30-day` whichever provider reports them. An account that's cooling down after a rejection is marked
`limited until <time>`.

The two providers report usage differently, and Rein handles each one:

- **Codex** has a free usage endpoint. Rein reads it every time you open `/usage`, and Codex also pushes
  updates during turns.
- **Claude** only reports usage alongside a request. Rein records it from every turn, and when the numbers
  are older than 10 minutes `/usage` sends a tiny Haiku request to get fresh ones. `/usage refresh` forces
  that check. A new Claude account shows `no usage data yet (appears after the first request)` until then.

When load balancing is on, Rein also refreshes usage in the background so it has numbers to balance with.
It starts 20 seconds after launch and runs every 10 minutes. Codex accounts are read for free. An idle Claude
account is pinged only if you have more than one Claude account and its numbers are over an hour old. Set
`REIN_NO_USAGE_REFRESH` to turn this off.

The top bar and sidebar show the active account's usage in short form, e.g. `5h 12% · weekly 3%`.

## Failover when an account hits its limit

Rein spots a limit from the CLI's own signals: Claude's `rate_limit_event` or its limit error text, and Codex's
`usageLimitExceeded`, `rateLimitExceeded` or `sessionBudgetExceeded`. Then:

1. The account is set aside until its reset time. If the reset time isn't known, Rein waits 15 minutes.
2. The **same turn is retried** on the next healthy account that offers the same model. If the reply had
   already started streaming, Rein drops that half-finished reply and tells you (`(partial reply discarded)`).
   The retry then produces the whole answer, so you never get a reply stitched together from two attempts.
3. If no account has that model left, Rein picks another model: auto routing chooses again without the failed
   model, or a pinned model is swapped for the one nearest in cost:
   `No Opus account available — switching to Sonnet`.
4. After 5 attempts Rein stops with `gave up after several failovers`. If every account for the model is
   cooling down you'll see `Every account for Sonnet is at its limit — earliest reset 5:30 PM.`

The same retry handles an account whose login has expired (`needs re-login (/login)`) and an overloaded
provider (`is overloaded`). Rein's transcript is the source of truth, so the new account's session gets the
conversation it missed carried over. You don't need to repeat anything.

An account also counts as unavailable before it's rejected, once its tightest window passes `maxUsedPct`
(98% by default) in `~/.rein/config.json`.

## Load balancing before limits hit

Failover is the safety net. Most of the time Rein moves you before a rejection ever happens. Each account
gets a balance score from its usage, with each window weighted by how soon it resets. Capacity that resets
in ten minutes is "use it or lose it", and each live session on an account counts against it, which spreads
parallel subagents across accounts.

A conversation stays on its account while the prompt cache is warm, because moving would waste the cache.
It moves when:

- its account is within 10% of a limit (`Load balancing: Claude Account 2 is near its limit — switching to Claude Account 1 before it's rejected`), or
- the cache is gone anyway (after compaction, or 60 minutes idle) **and** another account scores at least
  15 points better.

Switch to `Sticky` in `/settings → Load balancing` to stay on one account until it can't continue. The full
algorithm is in [Load balancing](../../internals/load-balancing/).

## Privacy

Privacy mode is on by default. Accounts show as `Claude Account 1`, `Codex Account 1` and so on everywhere,
including notices and windows, so you can share screenshots safely. Turn it off in
`/settings → Privacy` to see emails instead.

## Gotchas

- **Codex needs a ChatGPT login.** API-key Codex logins aren't supported.
- **A failover throws away a partial reply.** The retried turn starts over on the new account, and anything
  that streamed before the limit is dropped.
- **Claude usage costs a tiny request to refresh.** Rein only does this when you ask (`/usage refresh`),
  when numbers are stale, or in the background with several Claude accounts.
- **Forks stay on their parent's account.** `/btw` and forked subagents branch the live native session, so
  they run on the same account as the conversation they forked.

## Related

- [Model routing](../routing/): how Rein picks a model for each turn
- [Load balancing](../../internals/load-balancing/): the scoring and switching rules in detail
- [Subagents](../subagents/): parallel work spread across accounts
- [Commands](../../reference/commands/): `/login`, `/usage` and the rest
- [Files](../../reference/files/): what lives in `~/.rein/`
