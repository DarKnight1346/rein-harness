---
title: Plan mode
description: Have the agent explore read-only, ask you what it can't infer, and present a plan with checkable milestones before it changes a single file.
---

Plan mode puts a hard lock on changes: the agent can read, search, run read-only commands and send subagents
exploring, but every edit is refused until you approve a plan. The plan it hands you is a real file in
`.rein/plans/` with milestones you can commit, resume later, or run as an evidence-checked [goal](../goals/).

## Quick example

```text title="rein"
> /plan add rate limiting to the public API

Plan mode on — nothing changes until you approve the plan (shift+tab turns it off).

⏺ Search(rateLimit|express-rate-limit)
⏺ Read(src/server/app.ts)
⏺ Shell(git log --oneline -- src/server)
⏺ Ask(2 questions: Which limit should apply to authenticated clients?)
```

The agent's questions open in a **Questions from the agent** window. Once it has what it needs, it presents the
plan in a scrollable **Plan — approve to start** window:

```text title="Plan — approve to start"
# Rate limiting for the public API

Goal: cap anonymous and authenticated traffic per client …

## Milestones
1. Limiter middleware exists with unit tests passing
2. /v1 routes return 429 with Retry-After past the limit
3. `npm test` passes

[1 Save & implement now]
[2 Save & start as a goal — tracked milestones, verified as it goes]
[3 Save only — start it later with /goal:plan]
[4 Keep planning — I'll give feedback]
```

## Turning plan mode on

| How | What happens |
| --- | --- |
| **Shift+Tab** | Toggles plan mode on or off. The input must be idle with no suggestion list open. |
| `/plan <task>` | Built-in skill: turns plan mode on and runs a standard planning workflow. |
| `/plan:deep <task>` | Built-in skill: turns plan mode on and runs a more thorough workflow for big or risky work. |
| Click `⏸ plan mode` | The yellow segment in the fullscreen top bar turns plan mode off. |
| `rein -p … --permission-mode plan` | Headless: read-only run, and the plan is printed as the result. See [Headless](../headless/). |

`/plan` and `/plan:deep` are **skills**, not built-in commands. Their `config.json` sets `"planMode": true`, so
running either one switches plan mode on first. Any skill you write can do the same (see [Skills](../skills/)), and if
the model calls a plan-mode skill itself through the `skill` tool, plan mode turns on then too.

While it's on, the top bar shows a yellow `⏸ plan mode` segment (classic mode shows it in the status line), and
each message you send carries a note telling the model the rules: explore with read-only tools, then call
`present_plan`.

## What the two skills tell the agent

Both skills are plain `SKILL.md` files in Rein's `skills/` folder. Here's what each one asks of the agent.

### `/plan`: plan before changing anything

1. **Restate the goal** in a sentence or two, so the plan stays anchored to what you asked.
2. **Explore read-only**: relevant code, tests, configs, docs. For a wide area, send subagents to explore in
   parallel. Note conventions from project memory, `AGENTS.md` / `CLAUDE.md` and scoped instructions.
3. **Clarify what it can't infer** with `ask_user`: one batched call with concrete options, and nothing the code
   or conversation already answers.
4. **Write the plan** in markdown: Goal, Approach, Steps (files and changes), Risks, Verification.
5. **Pick 2–10 milestones**: ordered, checkable outcomes, each provable with a command or check.
6. **Call `present_plan`**, then revise until you save it. When implementing, keep a `todo_write` task list; as
   a goal, call `milestone_done` with evidence after each milestone.

### `/plan:deep`: thorough planning for big or risky changes

Same shape, with more investment up front:

- **Map the territory** broadly: code paths, callers and dependents, tests, configs, data and migrations, docs,
  and recent history (`git log` on the affected files), with **several subagents in parallel** each reporting back.
- **Ask more than usual.** Settle scope, edge cases, compatibility and migration, performance and security,
  testing expectations and rollout. Expect one or two rounds of questions.
- **Consult the advisor on the approach** before writing, if the `advisor` tool is available (see
  [Routing](../routing/)).
- **A fuller plan**: Goal and success criteria, Approach (with rejected alternatives and why), ordered Steps
  with dependencies, Risks & mitigations, Verification, and **Rollback**.
- **3–10 milestones**, each independently verifiable.
- **Have the advisor review the draft plan and milestones**, and fold in what holds up, before calling
  `present_plan`.

## Read-only, enforced

Plan mode isn't a suggestion in the prompt: Rein's tool host enforces it on every call, for the main agent and its
subagents alike.

- **File changes are refused.** `write`, `edit`, `delete` and other mutating tools fail with
  *"plan mode is on — nothing can be changed until the user approves your plan"*. The one exception is the
  session scratchpad, so the agent can keep notes.
- **Read-only shell commands run without asking.** A built-in allowlist covers programs that only read
  (`ls`, `cat`, `grep`, `rg`, `find`, `jq`, `diff`, `ps`, …) and the read-only subcommands of common tools
  (`git status/log/diff/show/blame`, `npm ls/view/outdated`, `docker ps/logs`, `kubectl get/describe`,
  `brew info`, `cargo tree`, …), plus a bare `<tool> --version` or `--help`. Every part of a compound command must
  pass, output redirection (`>`, `>>`) disqualifies it, and writing forms are caught (`find -delete`/`-exec`,
  `sort -o`, `git branch <new>`, `git stash` other than `list`/`show`, `npm audit fix`, …).
- **Anything else goes to the decision model.** It is asked whether the command only reads (any file write,
  package install, git commit/checkout/reset, service start/stop or upload counts as a change). At **0.85**
  confidence or higher the command runs, and the tool line notes the verdict (for example `· auto-approved (read-only, 0.93 via jev)`).
- **If the decision model can't say yes**, you're asked, with only two choices, *1 Allow* and *4 Deny*, under the
  warning *"⏸ Plan mode: this command isn't known to be read-only — allow it only if it just looks things up."*
  "Allow for this session" and "Always allow" are not offered, and a saved allow rule doesn't skip this prompt.
  Deny rules still block as usual.

:::caution[Bypass mode doesn't bypass plan mode]
With `/settings` → General → Approvals set to **Bypass**, a command the decision model can't clear is **refused**, not
prompted. The agent is told to stick to plain read-only commands (one per call, no loops or substitutions) and get
on with the plan. See [Permissions](../permissions/).
:::

## Questions: `ask_user`

`ask_user` is how the agent settles decisions instead of guessing. One call carries up to **6 questions**, each
with **2–8 options** (label plus a short consequence) and an optional `multi` flag. Every question also gets a
**Something else** row for your own answer.

```text title="Questions from the agent"
Question 1 of 2
Which limit should apply to authenticated clients?

❯ ○ 600 req/min per token — higher ceiling for logged-in users
  ○ Same as anonymous — one rule for everyone
  Something else: (↓ to type)

enter choose · ↑↓ move · ←→ question · esc dismiss
```

Multi-select questions use `space toggle · enter next`. Answers go back together after the last question. Esc
dismisses the window, and the agent is told to ask in plain text or proceed with stated assumptions. `ask_user`
works outside plan mode too, but only the main agent has it.

## Approving: `present_plan`

`present_plan` only works in plan mode. It takes a title, the plan in markdown and the ordered milestones. The
skills ask for 2–10; the tool rejects a plan with no milestones or more than 12. The window renders the plan as
markdown (↑↓, PgUp/PgDn or the mouse wheel to scroll) with four choices:

| Choice | Keys | Result |
| --- | --- | --- |
| **1 Save & implement now** | `1` or Enter | Saves the plan, turns plan mode off, and the agent carries it out step by step with a `todo_write` task list. |
| **2 Save & start as a goal** | `2` | Saves the plan, turns plan mode off, and starts a [goal](../goals/) linked to the file: `◎ Plan saved and started as a goal — milestones in the sidebar (plan mode off).` |
| **3 Save only** | `3` | Saves the plan and turns plan mode off. The agent confirms and stops: `Plan saved to .rein/plans/ — start it any time with /goal:plan (plan mode off).` |
| **4 Keep planning** | `4` or Esc | Nothing is saved, plan mode stays on, and you type your feedback: `Keep planning — type your feedback.` |

:::note
Approving a plan doesn't widen permissions. After **Save & implement now** the agent's edits go through your normal
approval mode (Ask, Auto or Bypass) like any other change.
:::

## A second opinion on the plan

A plan is cheapest to fix before any code exists. With `planReview` on (`/settings` → Agents → Plan review), the first plan the agent presents in a planning session goes to a **second model** before you see it. That's the other provider's best available model (`other`: Codex reviews a Claude plan, and the other way round) or your [advisor](../routing/) (`advisor`). It looks for parts of the request the plan misses, steps that won't work or are out of order, unhandled risks, simpler approaches, and verification that wouldn't prove anything.

Its critique goes to the agent, not to you. The agent checks each point against the code, folds in the ones that hold up, says in a line why it rejects the others, and presents the revised plan. That's the one you approve. Turning plan mode off and on again starts a new session, with a new review. If the reviewer finds nothing, or there's no model to review with, the plan comes straight to you.

The same review runs on a [spec's](../specs/) design stage. It's off by default because it costs one extra request per plan.

## Plan files in `.rein/plans/`

Every choice except *Keep planning* writes the plan to `.rein/plans/YYYY-MM-DD-<slug>.md` in your project. The slug
comes from the title (lowercase, max 50 characters), and a `-2`, `-3`… suffix avoids overwriting an existing file.
Any milestones section the agent wrote in the plan body is replaced by a standard checklist at the end:

```md title=".rein/plans/2026-10-03-rate-limiting-for-the-public-api.md"
# Rate limiting for the public API

**Goal:** cap anonymous and authenticated traffic per client.

**Approach:** …

**Steps:** …

## Milestones

- [ ] Limiter middleware exists with unit tests passing
- [ ] /v1 routes return 429 with Retry-After past the limit
- [ ] `npm test` passes
```

They're ordinary markdown, so you can read them, edit them and commit them. The `## Milestones` checklist is the
progress record: when a goal runs from the plan, each `milestone_done` that the decision model accepts ticks a box
(`- [x]`) in the file. Progress survives sessions, and a plan counts as complete once every box is ticked.

## Running a saved plan: `/goal:plan`

`/goal:plan` opens **Start a plan as a goal**: your unfinished plans, newest first, with progress and age, plus a
**✎ Start a new plan** row that puts `/plan ` in your input.

```text title="Start a plan as a goal"
Unfinished plans in .rein/plans/ (newest first):

❯ Rate limiting for the public API · 1/3 milestones · 2d ago
  Migrate config loader to ESM · 0/5 milestones · 9d ago
  ✎ Start a new plan

enter start as a goal · ↑↓ select · esc close
```

Picking a plan sets the goal `Carry out the plan "<title>"` and starts work right away:

```text title="rein"
◎ Goal: carry out the plan "Rate limiting for the public API" — 1/3 milestones done. Progress shows in the sidebar; /goal pause · resume · clear
```

From there the goal loop takes over. The agent reads the plan file, works through the open milestones in order and
calls `milestone_done` with evidence after each one. A decision model checks that evidence (0.7 or higher to accept)
before the box is ticked. `goal_done` is refused while any milestone is still open. The top bar shows
`◎ goal · active · 1/3` and the sidebar's GOAL section lists the milestones. See [Goals](../goals/) for the full loop.

## Gotchas

- **Revising keeps plan mode on.** Only choices 1–3 turn it off. Shift+Tab or the top-bar segment turn it off
  manually at any time.
- **No `present_plan` outside plan mode.** If plan mode is off, the tool errors and the agent goes ahead with the
  work.
- **Headless runs don't wait for approval.** With `--permission-mode plan`, the plan is saved to `.rein/plans/`,
  printed as the result, and nothing else changes. `ask_user` gets no answer there, so the agent states its
  assumptions and continues.
- **Subagents are read-only too.** Plan mode applies to every tool call, including subagents'. Only the main agent can
  call `ask_user` and `present_plan`.

## Related

- [Goals](../goals/): the evidence-checked loop that runs saved plans
- [Subagents](../subagents/): parallel read-only exploration during planning
- [Skills](../skills/): write your own `planMode` skill
- [Permissions](../permissions/): approval modes and rules
- [Headless](../headless/): `--permission-mode plan`
- [Commands reference](../../reference/commands/)
