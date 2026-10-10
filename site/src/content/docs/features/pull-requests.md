---
title: Pull requests
description: From a change to a merged pull request. Provenance on agent commits, reviews before you open a PR, digests for reviewers, split and stacked PRs, answering review comments, and merge queues.
---

Agents write code faster than people review it. These features make agent PRs easier to review and easier to land.

:::note[CI and pull requests pack]
`/pr` is in the **CI and pull requests** pack, which is off by default: turn it on in `/settings` → **Packs** ([Packs](../../reference/commands/#packs)). What Rein does on its own here works without it.
:::

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

## `/pr`

`/pr` works on the current branch's pull request, through the [GitHub CLI](https://cli.github.com) (`gh`, signed in):

```text title="rein"
> /pr
  ⎿ #42 Rate limiting · open · feat/limit → main
      +120 −8 in 5 files · review: changes requested · merge: blocked
      https://github.com/acme/app/pull/42
    /pr digest · /pr split · /pr comments · /pr queue
```

### A digest for reviewers

`/pr digest` writes what a reviewer reads first, from the branch's diff against its base and the test runs in this conversation: **Summary** (what changed and why), **Look closely at** (the risky parts, by file) and **Tests** (what was run and the result, or that nothing was). It's written by the [compaction model](../routing/), the cheap one, not the agent. When the branch changes [specs](../specs/) or saved [plans](../plans/), a **Specs and plans** section lists them. `/pr digest post` adds it to the pull request as a comment.

### Smaller PRs

Big PRs wait longest for review. Set `prMaxLines` (`/settings prMaxLines 400`; `0`, the default, is off) and Rein tells you, once per request, when the branch changes more lines than that against its base. The agent isn't told.

`/pr split` asks the agent to split the branch into a **stack** of smaller pull requests: it proposes the parts (each coherent, building and passing tests on its own, in dependency order), then creates them as local branches, each based on the previous, with clear commits. The original branch stays as it was, and nothing is pushed: you decide what to open.

### Review comments

`/pr comments` reads the review comments on the PR (inline ones with their file and line, and the reviews' own text) and hands them to the agent: fix the code where the reviewer is right, or draft a reply where not. It commits the fixes and lists the drafted replies for you; it doesn't push or post replies itself. Reviewers' text is treated as feedback, never as instructions to run.

### Merge queues

`/pr queue` says how Rein would queue the PR; `/pr queue yes` does it:

| Set up | What runs |
|---|---|
| [Mergify](https://mergify.com) (`.mergify.yml`) | A `@Mergifyio queue` comment on the PR |
| [Graphite](https://graphite.dev) (`gt` installed, repo initialized) | `gt merge` |
| GitLab (the `origin` remote is on GitLab) | `glab mr merge --auto-merge` |
| Otherwise | `gh pr merge --auto --squash`: GitHub auto-merge, through the merge queue when the base branch has one |

## A reviewer in CI

The [Rein GitHub Action](../headless/#the-rein-github-action) with `post-comment: true` reviews each pull request in CI and leaves the review as a comment, with the model and what it cost.

## Changes across repos

In a [workspace](../workspaces/), `/workspace prs` and `/workspace link-prs` find the pull request for the same branch in each repo and link them to each other. See [Pull requests across repos](../workspaces/#pull-requests-across-repos).

## Sharing a session

`/export html [file]` saves the conversation as one self-contained page (default `~/.rein/exports/<id>.html`): your messages, the agent's replies, each tool call with ✓ or ✗, and the diff of every edit. Attach it to a PR or a ticket to show how a change was made. Privacy mode applies, as on screen, and any HTML in the conversation is shown as text, never run. `/export` without `html` saves Markdown without the diffs.

## Related

- [Headless & CI](../headless/): the GitHub Action and GitLab component
- [Build & test](../build-and-test/): the CI watcher
- [Workspaces](../workspaces/): changes across repos
