---
title: Goals
description: Give Rein a standing objective with /goal and it keeps the agent working, turn after turn, until a separate model verifies the evidence that it's done.
---

`/goal` turns "please keep going" into a contract. You state the outcome once; Rein keeps the agent on it across as many turns as it takes, and the goal only ends when an independent decision model looks at the **evidence in the conversation** — test runs, command output, files read — and agrees it's achieved. "It's impossible" doesn't end a goal either: it gets the agent help.

## Quick example

```text title="rein"
> /goal make the test suite pass on Node 22
◎ Goal set: make the test suite pass on Node 22
The agent keeps working until the decision model verifies it's done (evidence required). /goal pause · resume · clear

  … the agent reads, edits, runs npm test …
goal: continuing (round 1)
  … more fixes, another test run …
goal: continuing (round 2)
  … goal_done: "Fixed the fetch polyfill and two snapshot tests"

◎ Goal achieved and verified: make the test suite pass on Node 22
accepted (0.93 via jev)
```

Between turns you'll see the working indicator read `Goal: checking progress` while Rein decides what to send next. The top bar shows `◎ goal · active` the whole time.

## Setting a goal

```text title="rein"
/goal <what "done" looks like>
```

Rein records the goal on the conversation and sends the agent a kickoff message that says, in short:

- work toward this goal now and keep going until it is fully achieved — Rein will keep you on it across turns;
- when it's achieved, call `goal_done` with concrete evidence ("what you ran/checked and what it showed"); a claim without evidence in this conversation is rejected;
- "Impossible" or "can't be done" is not a way to finish — look for another approach, consult the advisor tool if available, or break the problem down.

If the agent is mid-turn when you set the goal, the kickoff is queued and goes out as soon as the turn ends.

:::tip[Write goals you can check]
The verifier accepts proof, not intent. "Make `npm test` pass", "the `/health` endpoint returns 200 in the dev server", or "port `src/legacy/` to TypeScript with `tsc --noEmit` clean" give the agent something it can demonstrate.
:::

The goal is stored in the session transcript, so it survives `/resume` — pick the session back up and the goal is still there. `/clear` starts a new conversation, and the goal goes with the old one.

## The loop

Every time a turn ends with the goal `active`, Rein asks the goal manager for the next step — unless you have messages queued, an approval is waiting, or background [subagents](../subagents/) are still working (it waits for their reports instead of nudging the agent).

1. **Round cap.** If `goalMaxRounds` is set and reached, the goal pauses itself (see [Limits](#round-limit)).
2. **Did the agent give up?** The decision model reads the agent's latest message and answers one question: does it declare the goal impossible, blocked, or give up on it — rather than reporting progress or asking you something it needs? At probability **≥ 0.6** it counts as giving up and Rein [escalates](#impossible-is-not-a-completion).
3. **Otherwise, a reminder.** Rein sends a `<goal_reminder>` restating the goal: keep working toward it; if it's achieved, call `goal_done` with evidence; otherwise take the next concrete step. The log shows `goal: continuing (round N)`.

The decision model is whatever you picked on the **Decision** tab of [`/model`](../routing/) — the cheapest available model by default, or Jev if you've selected and keyed it. These checks never see your whole transcript; they see the goal and the latest message.

## `goal_done`: evidence, not claims

The agent can only finish by calling `goal_done` with two fields:

| Field | What goes in it |
| --- | --- |
| `summary` | What was done to achieve the goal |
| `evidence` | Concrete proof: what was run or checked and what it showed, e.g. `npm test: 42 passed, 0 failed` |

Rein doesn't take the agent's word for it. The decision model reviews:

- the goal text,
- the agent's summary and evidence,
- the **last 30 tool calls since the goal started**, each with its arguments, `ok`/`FAILED` status and a result excerpt,
- the agent's latest message,

and answers: *do the tool results and evidence in context concretely show that the goal is fully achieved (e.g. passing tests, verified output, files present)?* A bare claim, a plan, partial progress, or "it is impossible" is explicitly **not** achieved.

The claim is accepted at probability **≥ 0.7**. Below that, the tool returns `Not accepted — rejected (0.42 via jev): the evidence in context doesn't show the goal is fully achieved. Keep working; produce concrete proof (run the tests/checks, show the output), then call goal_done again.` — and the loop carries on.

When an advisor is set (`/model` → Advisor), a rejection doesn't stop at "keep working": Rein asks the advisor what's most likely missing and which steps would prove it, and appends its answer (`The advisor's take on what's missing: …`). Rejected `milestone_done` calls get the same treatment.

Because the evidence window is the tool calls *since the goal started*, a test run from before you typed `/goal` doesn't count. The agent has to actually run the check.

## "Impossible" is not a completion

When the gave-up check fires, Rein gets outside input instead of stopping:

- If an **advisor model** is configured (the Advisor tab of `/model`), Rein asks it for a concrete path forward — alternative approaches, what to check, how to break the problem down — and tells it to assume the goal *can* be done.
- With no advisor, Rein spawns a fresh subagent named **`goal-unblocker`** (new session, model `auto`) to investigate the codebase and environment and report a plan, or the solution, back to the main agent.

The answer goes to the agent wrapped in `<goal_escalation>"Impossible" is not a completion. Input from the advisor: …</goal_escalation>`, followed by the goal and a reminder to call `goal_done` only with evidence. The log shows `goal: the agent said it's impossible — asked the advisor for a way forward` (or `a subagent`), and the escalation count goes up.

:::note
The agent asking you a genuinely necessary question is *not* giving up. The check is worded so that "still working, reporting progress, or asking the user something necessary" passes through as a normal turn — answer it and the loop continues.
:::

## Pause, resume, clear

| Command | Effect |
| --- | --- |
| `/goal` | Opens the **Goal** window: status, continuation and escalation counts, and the last 8 checks with timestamps (classic mode prints the same summary) |
| `/goal pause` | `Goal paused — the current turn finishes, then the agent stops. /goal resume continues.` |
| `/goal resume` | `Goal resumed: …` and the loop wakes immediately |
| `/goal clear` | Removes the goal |

Interrupting also pauses: **Esc** while the main agent is working, or **Ctrl+C** at any time, stops the turn and logs `Goal paused (/goal resume to continue).` Nothing is lost — the goal, its round count and its checks stay on the conversation.

The Goal window looks like this:

```text title="Goal"
◎ make the test suite pass on Node 22
status: paused · 7 continuations · 1 escalation
  14:02:11 turn: gave up → escalated to the advisor
  14:09:40 done claim: rejected (0.38 via jev)
  14:15:02 turn: paused after 25 automatic continuations (limit in /settings → Goals)

/goal pause · /goal resume · /goal clear
```

## Goals from a plan

A goal can carry out a saved [plan](../plans/). Choose **Save & start as a goal** when a plan is presented, or run `/goal:plan` and pick an unfinished plan from `.rein/plans/` (or `✎ Start a new plan`):

```text title="Start a plan as a goal"
Unfinished plans in .rein/plans/ (newest first):

❯ Migrate auth to sessions · 0/5 milestones · 2h ago
  Add dark mode · 3/6 milestones · 3d ago
  ✎ Start a new plan

enter start as a goal · ↑↓ select · esc close
```

The goal becomes `Carry out the plan "<title>"`, linked to the plan file, and the kickoff tells the agent to read the plan first and work through its milestones in order:

```text
✓ 1. Add the sessions table and migration
→ 2. Replace JWT middleware with session lookup
  3. Update login/logout routes
```

Plan-linked goals add one rule each way:

- **`milestone_done`** — after each milestone the agent calls it with the milestone number and evidence. The same decision-model review runs (same **0.7** bar, scoped to that milestone), and on acceptance Rein ticks the box in the plan file itself — `- [ ]` becomes `- [x]`. Progress lives in the markdown, so it survives sessions and can be committed.
- **`goal_done` is refused while milestones are open** — `milestones not done yet: 2. …; 3. … — finish them (milestone_done each) first`.

Each `<goal_reminder>` re-lists the milestones with the next one marked `→`, so the agent always knows where it is.

## Where you see it

- **Top bar** (fullscreen): `◎ goal · active`, plus `· 3/5` milestones for a plan goal. Cyan while active, yellow when paused, green when done. Click it to open the Goal window.
- **Sidebar**: a plan goal gets a **GOAL** section at the top — `GOAL · 3/5`, the plan title, a progress bar with a percentage, and up to 12 milestones (`✓` done, `▸` next, `○` later). Click the heading for the Goal window. If the agent keeps a task list with `todo_write`, a **TASKS** section follows it.
- **Classic mode**: the status bar shows `◎ goal active`.

## Limits and gotchas

### Round limit

`goalMaxRounds` caps automatic continuations. It defaults to `0` (unlimited); set it in **/settings → Goals** to 10, 25, 50, 100 or 250. When the cap is hit the goal pauses with `paused after N automatic continuations (limit in /settings → Goals)`. `/goal resume` past the cap resets the counter, so you get another full run.

```json title="~/.rein/config.json"
{
  "goalMaxRounds": 25
}
```

- **One goal per conversation.** Setting a new goal replaces the old one.
- **Main agent only.** `goal_done` and `milestone_done` aren't available to subagents; they error when no goal (or no plan-linked goal) is active.
- **The verifier is a model.** It's strict by design, but it judges what's in context. If your success criterion can't be shown by a command or file, phrase the goal so it can.
- **Unlimited means unlimited.** With the default cap, a goal the agent can't reach keeps consuming turns until you pause it. Set a cap if you leave Rein unattended.

## Related

- [Plans](../plans/) — draft a plan with milestones, then run it as a goal
- [Subagents](../subagents/) — background agents the goal loop waits for, and `goal-unblocker`
- [Model routing](../routing/) — choosing the decision and advisor models
- [Decision model internals](../../internals/decision-model/)
- [Commands reference](../../reference/commands/) · [Configuration reference](../../reference/configuration/)
