---
title: Specs
description: Spec mode writes requirements, a design and tasks, each approved by you before the next. Tasks form a graph that runs in parallel, and every requirement traces to the code that meets it. Specs are files you commit and review in the PR.
---

A [plan](../plans/) is enough for most changes. For a feature that several people will review, or one big enough to split across subagents, write a **spec**: what it must do, how it will be built, and the tasks to get there. You approve each part before the next one is written, and before any code changes.

```text title="rein"
> /spec retry failed card charges with backoff, and count the retries
  ⎿ Spec mode on: retry-failed-card-charges-with-backoff (.rein/specs/retry-failed-card-charges-with-backoff/).
    You'll approve the requirements, the design and the tasks in turn; nothing changes until then.
```

## Three stages, each approved

1. **Requirements** (`requirements.md`): the agent explores the code read-only, asks what it can't infer, and writes numbered requirements `R1`, `R2`… with testable acceptance criteria.
2. **Design** (`design.md`): the approach, the components and files involved, interfaces and error handling, and which requirement each part meets. With [`planReview`](../plans/#a-second-opinion-on-the-plan) on, a second model critiques it first.
3. **Tasks** (`tasks.md`): a checklist that names the requirements each task meets and the tasks it comes after:

```markdown title=".rein/specs/retry/tasks.md"
- [ ] T1: Add the retry queue (R1)
- [ ] T2: Exponential backoff policy (R1) after: T1
- [ ] T3: Count retries in metrics (R2) after: T1
- [ ] T4: Document the retry behaviour after: T2, T3
```

After each stage you get a question: *Approve* or *Revise* (type what to change). Rein checks each stage before it asks you. Requirements must be numbered. Tasks must have no cycles, no dependencies on tasks that don't exist, and no requirements that aren't in `requirements.md`. Rewriting an earlier stage un-approves the later ones, since they were written against the old version.

Spec mode blocks changes the way [plan mode](../plans/) does, until you approve the tasks. `Shift+Tab` turns it off. `/spec resume <name>` picks a spec up where it stopped.

## Tasks as a graph

Once the tasks are approved, Rein works out which ones are ready: not done, with everything they come after done. In the example, T1 runs first. When T1 is done, T2 and T3 don't depend on each other, so the agent is told to run them **in parallel, one [subagent](../subagents/) each**, in their own worktrees. T4 waits for both.

The agent marks progress with [`spec_task`](../../reference/tools/#spec_task): `start` before a task, `done` after it. `done` ticks the box in `tasks.md` and replies with the next ready set. `/spec resume <name>` on a spec whose tasks are approved carries on from the tasks still open.

## Requirement to code

`spec_task start` records the project's files (in a private store, like [`/rewind`](../rewind/)'s, never your `.git`). `spec_task done` records the lines that changed since, against the task and its requirements. Rein keeps the result in `trace.md`, next to the spec:

```markdown title=".rein/specs/retry/trace.md"
## R1

- **T1** Add the retry queue
  - `billing/retry.ts`: 1-48
  - `billing/charge.ts`: 112-130
- **T2** Exponential backoff policy
  - `billing/backoff.ts`: 1-30

## R2

Nothing traces to this requirement yet.
```

A requirement with nothing under it hasn't been built. `/spec trace <name>` shows the same thing in the terminal. Line numbers are the ones each task left; later tasks can move them.

## Reviewed with the code

A spec is plain markdown in `.rein/specs/<name>/` in your project, so it goes in the same commit and the same pull request as the code. Approved stages start with `<!-- approved YYYY-MM-DD -->`. The [`/pr` digest](../pull-requests/#a-digest-for-reviewers) ends with a **Specs and plans** section listing the specs and [saved plans](../plans/) the branch changes, so the reviewer reads the requirements next to the diff.

`/spec` on its own lists the specs and how far along each one is.

## Architecture decisions

Architecture decision records (ADRs) are the "why" behind a codebase: one numbered markdown file per decision, with its context, the decision and its consequences. Rein reads them where [adr-tools](https://github.com/npryce/adr-tools) and [MADR](https://adr.github.io/madr/) put them: the folder named in `.adr-dir`, or else `docs/adr/`, `docs/adrs/`, `doc/adr/`, `adr/`, `docs/architecture/decisions/` or `docs/decisions/`.

```text title="rein"
> /adr
  ⎿ Architecture decisions in docs/adr/:
      0001  Record architecture decisions  (accepted)
      0002  Use MongoDB  (superseded by)
      0003  Use Postgres for the ledger  (accepted)

> /adr new Queue retries in Redis
  ⎿ Created docs/adr/0004-queue-retries-in-redis.md (status Proposed).
```

`/adr new <title>` writes the next numbered file (Date, Status *Proposed*, Context, Decision, Consequences) and asks the agent to fill it in from the conversation and the code.

With the `adr-check` [experiment](../../reference/configuration/#experiments) on, [plan mode](../plans/) and spec mode give the agent the decisions in force (accepted or proposed; not superseded, deprecated or rejected). The agent checks its plan against them. If the plan goes against one, it says so under Risks and proposes a new ADR that supersedes it, instead of quietly diverging.

## Related

- [Plan mode](../plans/): a single plan with milestones, for smaller changes
- [Goals](../goals/): keep working until the result is verified
- [Subagents](../subagents/): how parallel tasks run
