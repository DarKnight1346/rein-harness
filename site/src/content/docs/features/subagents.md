---
title: Subagents
description: Let the agent delegate work to parallel subagents, forked from the conversation or started fresh on any signed-in model, with a decision-model check that each one actually finished.
---

Rein's agent can hand work to **subagents**: copies that branch off the conversation, or fresh sessions on whichever model fits the job. They run in parallel, show up live in the sidebar, and you can open any one of them and talk to it. Before a report goes back to the main agent, a decision model checks that the subagent really did the work and didn't stop at a plan.

## Quick example

Ask for something that splits up naturally:

```text title="rein"
> Add tests for the parser and the tokenizer, and update the docs for both

⏺ Agent(parser-tests · auto · background)
  Started subagent #1 "parser-tests" (new, auto). Collect its report with agent_result {id: 1, wait: true}.
⏺ Agent(tokenizer-tests · auto · background)
  Started subagent #2 "tokenizer-tests" (new, auto). Collect its report with agent_result {id: 2, wait: true}.
⏺ Agent(docs · fork · background)
  Started subagent #3 "docs" (fork). Collect its report with agent_result {id: 3, wait: true}.
```

The top bar shows `● 3 agents`. Click a subagent in the sidebar's **AGENTS** section (or the top bar segment) and the main pane switches to its conversation:

```text title="rein — viewing a subagent"
◆ Subagent #1 parser-tests · Sonnet · new · running 41s
  Task: Write unit tests for src/parser.ts covering …

⏺ Read(src/parser.ts)
  Read 212 lines
⏺ Write(test/parser.test.ts)
⏺ Shell(npm test -- parser)
  completion check: complete (0.93 via jev)

parser-tests running 41s · type to message it · ◂ main in the sidebar or /agent main to go back
```

## How the agent uses it

The main agent gets two tools: `agent` to spawn a subagent and `agent_result` to collect one. Each subagent has the same tools as the main agent: files, shell, web, MCP, skills. Its tool calls go through the same [permission pipeline](../permissions/).

| `agent` argument | Meaning |
|---|---|
| `task` | Complete, self-contained instructions (what to do, where, what to report). Required. |
| `mode` | `fork` or `new`. Required. |
| `model` | For `new` mode: a signed-in model, or `auto`. Fork mode ignores it. |
| `name` | Short name shown to you, e.g. `test-writer`. Defaults to `agent-<id>`. |
| `background` | `true` returns an id at once. Otherwise the call waits and returns the report. |

### Fork vs new

- **`fork`** branches the current native CLI session. The subagent keeps the **full conversation history** and runs on the parent's current model and account. Use it for parallel work that needs everything said so far. On Claude this is a `--resume --fork-session` of the live session. On Codex it's a `thread/fork`. The parent session isn't touched.
- **`new`** opens a fresh session with no history, on any model you're signed into. The task has to stand on its own. Use it for independent work, or to put a cheaper or stronger model on a piece of the job.

A fork needs a live session to branch from. If there's nothing to fork yet, the call fails and the agent is told to use `new`.

### Which model a new subagent gets

Two `/model` tabs decide this (see [Routing](../routing/)):

- **Subagents** (`subagentModel`, default `auto`) is *your* model for new subagents.
- **Subagent priority** (`subagentPriority`, default `user`) picks whose choice wins:

| Priority | Order |
|---|---|
| `user`, **Your model first** (default) | your Subagents model → the agent's choice → auto |
| `agent`, **Agent's choice first** | the agent's choice → your Subagents model → auto |

If you've pinned a Subagents model and priority is "Your model first", the agent isn't offered a choice at all. The `model` parameter disappears from its tool and it's told new subagents run on your model. Otherwise the tool description lists every model available right now, with a cost hint (`very low` … `highest`) so the agent can match model to task.

`auto` runs the same [auto router](../routing/) as the chat, on the task text alone. The subagent then starts on the healthiest account for that model. Live sessions count against an account's [load-balancing](../../internals/load-balancing/) score, so a batch of subagents spreads across your subscriptions instead of piling onto one.

## Foreground, background, and reports

There are two ways to work with subagents, and the agent picks one per task:

- **Orchestrate.** Spawn several with `background: true`, then collect each with `agent_result {id, wait: true}`. The main agent waits while they work.
- **Work alongside.** Spawn in the background and keep working with its own tools, then collect results when it needs them.

`agent_result` with no `id` lists every subagent with its model, mode and status. With an `id` and no `wait` it returns the report, or a "still running" note.

**Reports are delivered automatically.** If the main agent ends its turn while background subagents are still running, nothing gets lost. When each one finishes, Rein queues its report as the main agent's next message:

```text title="rein"
Subagent parser-tests finished (done) — its report goes to the main agent.
```

The agent receives it wrapped in `<subagent_report id="1" name="parser-tests" status="done">` with "Continue with this result." So the agent can fan out work, end its turn, and get woken up as results come in. A report it already collected with `agent_result` isn't delivered a second time.

## The completion check

After each subagent turn, the [decision model](../../internals/decision-model/) gets the task, the final report and the last 40 tool calls, and answers one question: *has the subagent fully completed the task it was given? Actually done, not just planned, partially done, or blocked?*

- At **0.5 or above** the work is accepted.
- Below that, the subagent is told: *"A completion check found that the task is not finished yet. Re-read the task, do whatever is still missing, and then give your final report."*
- This repeats **at most 3 extra rounds**. After that the subagent stops with `Stopped after 3 continuation rounds.` and its report goes back as-is.

Each verdict shows in the subagent's view, e.g. `completion check: not complete (0.31 via jev) → continuing`. The report header tells the main agent how many continuation rounds it took. If the check itself fails (say no decision model is reachable), the work is accepted rather than blocked.

## Limits

- **Concurrency.** At most `subagentLimit` subagents run at once (default **10**). Set it in [`/configure`](../tui/) → Subagents: 1, 2, 3, 5, 10 or 20. The agent is told the limit. When it's reached, `agent` returns an error telling it to wait with `agent_result` or do the work itself.
- **No nesting.** Subagents can't spawn subagents. `agent`, `agent_result`, `ask_user`, `todo_write`, `present_plan`, `milestone_done` and `goal_done` belong to the main agent only. Forks still see those definitions, because their history references them, but calling one fails with `only available to the main agent`.
- **`/model` targets the main agent.** Changing the chat model while you're viewing a subagent changes the main agent's model; the subagent keeps its own.
- **No questions.** Subagents are told the user won't answer questions, so they work autonomously and report what's left undone and why.

## Watching and steering subagents

In the [fullscreen UI](../tui/):

- The sidebar's **AGENTS** section lists `main` plus every running subagent (`●` yellow running, `✓` done, `✗` failed, `■` stopped) with its model. Finished subagents drop off once you look away.
- **`/agents`** opens the **Subagents** window with every subagent this conversation spawned, finished ones included: id, name, model · mode, status, task. `enter` or a click opens one, `k` stops it.
- **`/agent <id>`** switches the main pane to that subagent. **`/agent main`**, the top bar's `◂ main · viewing <name>`, or `main` in the sidebar switches back.
- The top bar's `● N agents` segment opens the only running subagent, or `/agents` when there are several.

While you're viewing a subagent, the input reads `message <name> (subagent)…`. Anything you type goes **to that subagent** as one more turn on its own session, with no completion check. Finished subagents keep their session open for exactly this. Ask a follow-up, request a fix, or dig into its report. Skills run there too. `Esc` stops the subagent you're looking at, `/shells` shows only its commands, `/context` shows its context, and [`/btw`](../btw/) forks it.

In classic mode, `/agents` prints the list and `/agent <id> <message>` talks to a subagent inline.

:::note[Main-conversation commands]
`/compact`, `/rewind` and `/clear` work on the main conversation. Run them while viewing a subagent and Rein asks you to switch back first. `/clear` also stops every subagent.
:::

### Approvals from many agents

Several agents can ask for approval at once, so requests **queue** and show one at a time. The window title says who's asking and how many are waiting:

```text title="rein"
Approve command (1 of 3) · subagent tokenizer-tests

Subagent tokenizer-tests wants to Shell npm test -- tokenizer
```

Choosing **2 Allow all changes & commands this session** also releases every request already waiting. With [Approvals set to auto](../permissions/), the decision model clears routine requests without interrupting you.

### Stopping

- `Esc` interrupts the main turn along with the **foreground** subagents it's waiting on. Background subagents keep running.
- `Esc` while viewing a subagent stops only that one.
- `Ctrl+C` stops everything: the main turn, every subagent, and their shell commands.

Stopped subagents report `cancelled` with whatever partial output they had.

## Orchestration patterns

Some shapes that work well:

- **Fan out, then merge.** Spawn several `new` subagents in the background on independent pieces (one per package, per test file, per endpoint), collect them, and let the main agent integrate and verify.
- **Context-heavy side task.** Use a `fork` when the subtask depends on decisions made earlier in the conversation: "write the migration guide for what we just changed."
- **Right-size the model.** Send mechanical work (renames, boilerplate tests, doc sweeps) to a cheap model with `new` mode and keep the main conversation on a stronger one. Or pin a Subagents model in `/model` and let priority enforce it.
- **Explore in parallel.** Have read-only investigators search different parts of a large codebase at once, each returning a focused report, so the main agent's context stays small.
- **Unstick a goal.** When a [`/goal`](../goals/) run reports it can't continue and no [advisor](../routing/) is set, Rein spawns a `goal-unblocker` subagent (new mode, auto model) to investigate. Its report goes back into the loop.

Subagent tokens are added to the conversation's totals. Each subagent's record (task, model, status, report, tool calls) is saved with the session.

## Related

- [Routing](../routing/): the Subagents and Subagent priority tabs in `/model`
- [Goals](../goals/): long-running objectives that can spawn a `goal-unblocker`
- [Permissions](../permissions/): approval modes and the queued approval window
- [TUI](../tui/): sidebar, top bar and windows
- [Load balancing](../../internals/load-balancing/): how subagents spread across accounts
- [Decision model](../../internals/decision-model/): what powers the completion check
