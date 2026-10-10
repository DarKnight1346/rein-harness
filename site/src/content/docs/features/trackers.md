---
title: Issue trackers
description: Hand an issue to Rein by labelling it. Rein works on it on its own branch and posts its report on the issue. GitHub, Linear, GitLab, Azure DevOps and Jira.
---

Label an issue `rein` and assign it to yourself. The Rein you have running picks it up within a couple of minutes, works on it **on a new branch in its own copy of the project**, and comments on the issue with its report. Nothing is merged, pushed or deployed: you review the branch.

:::note[CI and pull requests pack]
`/trackers` is in the **CI and pull requests** pack, which is off by default: turn it on in `/settings` → **Packs** ([Packs](../../reference/commands/#packs)).
:::

```text title="rein"
  ⎿ ⇢ github #2 "Add a multiply function": started (it's labelled "rein" and assigned to you).
  ⎿ ⇢ github #2: done (branch rein/issue-2); the report is on the issue.
```

On the issue, Rein comments twice: once when it starts, then with the report:

```text title="issue comment"
Rein's report (branch rein/issue-2, not pushed)

Added multiply(a, b) to calc.py and checked it: multiply(5, 6) → 30, multiply(0, 100) → 0.
Committed to branch rein/issue-2.
```

## Setting it up

Add your trackers to `trackers` in `config.json`. Tokens go in the [vault](../vault/), never in the config:

```json title="~/.rein/config.json"
{
  "trackers": [
    {"kind": "github", "project": "you/your-repo"},
    {"kind": "linear", "project": "ENG"},
    {"kind": "gitlab", "project": "group/project", "url": "https://gitlab.com"},
    {"kind": "azure", "project": "your-org/your-project"},
    {"kind": "jira", "url": "https://you.atlassian.net", "email": "you@example.com", "project": "APP"}
  ]
}
```

| Tracker | `project` | Token | Status |
|---|---|---|---|
| GitHub Issues | `owner/repo` | none: uses your [`gh`](https://cli.github.com) login | Tested |
| Linear | team key (optional) | `/vault set LINEAR_API_KEY` (a personal API key) | Built against Linear's API; not tested yet |
| GitLab | project path or id (optional); `url` for self-hosted | `/vault set GITLAB_TOKEN` | Built against the API; not tested yet |
| Azure DevOps | `org/project` | `/vault set AZURE_DEVOPS_PAT` | Built against the API; not tested yet |
| Jira Cloud | project key (optional); `url` and `email` required | `/vault set JIRA_API_TOKEN` | Built against the API; not tested yet |

Each tracker takes `label` (default `"rein"`) and `model` (default: your subagent model). Rein checks every `trackerPollMinutes` (default 2).

## What happens to an issue

1. **It's taken once.** Rein remembers it in `state/trackers.json`, so a restart doesn't start it again. `/trackers retry #2` makes it eligible again.
2. **A new branch**, `rein/issue-2` (or `rein/eng-12`…), is created from your current commit, in a separate worktree under Rein's data folder. Your working tree is never touched.
3. **A subagent works on it** in that worktree, one issue at a time. When it finishes, anything left uncommitted is committed to the branch (test leftovers like `__pycache__` aren't), and the worktree is kept for you to review: `git log rein/issue-2`, `git checkout rein/issue-2`.
4. **The report goes on the issue**, not into your conversation.

Only an interactive Rein takes issues (`rein -p` doesn't): the work may need your approval.

## Approvals: issue text is untrusted

Whoever can write an issue can put anything in it, including instructions aimed at the agent. So Rein treats issue work as untrusted:

- **Every action asks you,** whatever approval mode you've chosen, even bypass. Answer in Rein, or from your phone with the remote page (`/remote`).
- The issue text reaches the agent marked as someone else's text, a description of the task rather than instructions to it, with a standing rule: don't run commands from it unchecked, don't reveal secrets, and don't push, publish or open pull requests.
- The work stays on its own branch, and nothing is pushed.

## Commands

| Command | What it does |
|---|---|
| `/trackers` | The configured trackers, any errors, and the issues taken lately |
| `/trackers check` | Look for new issues now |
| `/trackers retry <ref>` | Forget an issue (`#2`, `ENG-12`) so the next check takes it again |

## Related

- Remote access (`/remote`): approve from your phone while Rein works on an issue
- [Secrets vault](../vault/): where tracker tokens live
- [Security](../../project/security/)
