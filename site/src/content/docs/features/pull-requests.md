---
title: Pull requests
description: From a change to a merged pull request. Provenance on agent commits, reviews before you open a PR, digests for reviewers, split and stacked PRs, answering review comments, and merge queues.
---

Agents write code faster than people review it. These features make agent PRs easier to review and easier to land.

## Provenance on agent commits

With `provenance` on (`/settings provenance true`), every commit the agent makes ends with trailers saying where it came from:

```text
Fix session expiry on refresh

Rein-Session: 2026-10-09-14-22-07-9f3c2a1b
Rein-Model: claude:opus
Rein-Goal: make the failing auth tests pass
```

Pull requests the agent opens end their description with the same lines. Rein puts the current values in every shell command's environment (`REIN_SESSION`, `REIN_MODEL`, and `REIN_GOAL` while a [goal](../goals/) is active) and asks the agent to write `$REIN_SESSION`-style trailers, so the shell fills them in: the model is the one actually working when the commit is made, even after a switch. Find agent commits later with `git log --grep "Rein-Session:"`.

## A review before it's done

With the `self-review` [experiment](../../reference/configuration/#experiments) on, when the agent is about to stop after changing files, the same model reviews the change in a fresh call: just your request, the `git diff` and new files, **without the conversation**, so it isn't anchored to how the change was made. Concrete problems (missed requirements, edge cases, bugs) go back to the agent to fix or dismiss. Once per request.

The `cross-review` experiment does the same with the strongest model of the *other* provider (Codex for a Claude conversation, and the reverse), when both are signed in. If both are on, cross-review runs and self-review is skipped for that request.

## Related

- [Headless & CI](../headless/): the GitHub Action and GitLab component
- [Build & test](../build-and-test/): the CI watcher
- [Workspaces](../workspaces/): changes across repos
