---
title: Headless mode
description: Run Rein non-interactively with rein -p for scripts and CI — piping, output formats, permissions without a human, plan-only runs and exit codes.
---

`rein -p` runs one prompt with no UI and prints the result, the same way `claude -p` does. You still get routing across your accounts, failover, every tool, your rules and your hooks, which makes it useful in shell scripts, git hooks and CI jobs. (Hooks a project ships run only once you've [trusted them](../hooks/#trusting-a-projects-hooks) in an interactive `rein`; untrusted ones are skipped with a note on stderr.)

```sh
git diff --staged | rein -p "review this diff for bugs; be brief"
```

## Quick examples

```sh
# Ask a question about the repo
rein -p "where is the retry logic for webhooks?"

# Pipe content in (it's appended to the prompt after a blank line)
cat error.log | rein -p "what's the root cause?"

# The prompt can come from stdin alone
echo "summarize README.md" | rein -p

# Machine-readable result
rein -p "list the public API functions in src/index.ts" --output-format json

# Let it fix things, within limits
rein -p "fix the failing unit tests" \
  --permission-mode auto \
  --allowedTools "shell(npm test:*),edit(src/**),edit(test/**)"

# Plan only: nothing changes, the plan is the output
rein -p "plan a migration from Jest to Vitest" --permission-mode plan

# Follow up in the same conversation
rein -p "now update the docs to match" -c
```

## Flags

| Flag | Meaning |
|---|---|
| `-p`, `--print "<prompt>"` | Headless mode. The prompt is optional if you pipe one in. |
| `--model <ref\|auto>` | Chat model for this run, e.g. `claude:sonnet`, or `auto` for per-task [routing](../routing/). |
| `--effort <level\|auto\|default>` | Reasoning effort for this run. |
| `--output-format text\|json\|stream-json` | Output shape (default `text`). See [below](#output-formats). |
| `--permission-mode ask\|auto\|bypass\|plan` | Approval mode for this run. **If omitted, your configured `toolApproval` applies.** See [Permissions](#permissions). |
| `--allowedTools "<rules>"` | Extra allow rules for this run, comma-separated (commas inside parentheses are kept). |
| `--disallowedTools "<rules>"` | Extra deny rules for this run. |
| `-c`, `--continue [id]` | Continue the latest conversation in this project, or the one with that id. |
| `--verbose` | Text mode: print tool calls and notices to stderr. |
| `--add-dir <path>` | Also let the agent use this folder without asking, for this run. Repeatable; adds to `additionalDirectories`. |
| `--scope <dir>` | Work in one package of a monorepo: `list`, `search` and `shell` start there, with its instructions. |

`--model`, `--effort` and `--permission-mode` apply to this run only. They're never saved to `~/.rein/config.json`.

`--permission-mode plan` works even though `rein --help` doesn't list it.

## Input

The prompt comes from `-p "<text>"`, from stdin, or both. Rein reads stdin only when something is actually piped or redirected in (a pipe or a file), so a CI step with no input doesn't hang waiting. When both are present, the piped text goes after your prompt, separated by a blank line.

You need at least one signed-in account. Without one, Rein exits with ``rein: no accounts yet — run `rein` once to import or add one``.

## Output formats

### `text` (default)

The reply streams to stdout as it's written. Errors go to stderr as `rein: <message>`. With `--verbose`, each tool call and notice is also printed to stderr:

```text title="stderr"
⏺ Search(retry in src) ✓
⏺ Read(src/webhooks/deliver.ts) ✓
⏺ Edit(src/webhooks/deliver.ts) ✗
```

### `json`

A single JSON object on stdout when the run ends:

```json
{
  "type": "result",
  "is_error": false,
  "result": "The retry logic lives in src/webhooks/deliver.ts: `deliverWithRetry` retries 5 times with exponential backoff…",
  "session_id": "2026-10-03-14-22-07-9f3c2a1b",
  "model": "claude:sonnet",
  "effort": "medium",
  "tools": [
    {"tool": "Search", "summary": "retry in src", "ok": true},
    {"tool": "Read", "summary": "src/webhooks/deliver.ts", "ok": true}
  ],
  "tokens": {"uncached": 18342, "cached": 41210, "output": 612, "usd": 0.0561},
  "cost_usd": 0.0561,
  "duration_ms": 14873
}
```

- `model` and `effort` come from the last routing decision. `effort` is left out when the model has none.
- `tools` lists the main agent's tool calls (label, summary, success). Subagents' calls aren't included.
- `tokens` are the conversation's running totals: `uncached` input, `cached` input and `output`, plus `usd` when the models have a price. `cost_usd` is that total, at API list prices (see [Cost & budgets](../cost/)). They include subagents and Rein's helper calls (compaction, the decision model, the advisor, `web_fetch`), not only the main model.
- On an early failure (bad flag, no prompt, no accounts) you get `{"type": "result", "is_error": true, "error": "…"}` instead.
- If the run hits an error partway through, `is_error` is `true`, `error` is set, and `result` holds whatever reply text arrived before it.

### `stream-json`

One JSON object per line as things happen, then the same `result` object as `json` mode at the end:

```json
{"type":"route","model":"claude:sonnet","effort":"medium"}
{"type":"tool","phase":"start","tool":"Read","summary":"src/webhooks/deliver.ts"}
{"type":"tool","phase":"end","tool":"Read","summary":"src/webhooks/deliver.ts","ok":true}
{"type":"text","delta":"The retry logic lives in "}
{"type":"text","delta":"src/webhooks/deliver.ts…"}
{"type":"tokens","call":{"input":59552,"cached":41210,"output":612,"written":18342,"usd":0.0561}}
{"type":"done","interrupted":false}
{"type":"result","is_error":false,"result":"…","session_id":"2026-10-03-14-22-07-9f3c2a1b","model":"claude:sonnet","effort":"medium","tools":[…],"tokens":{…},"cost_usd":0.0561,"duration_ms":14873}
```

You may also see `notice` (`{"type":"notice","text":"…"}`), `compact` and `error` events. Tool events from subagents appear in the stream too.

:::caution[Privacy redaction applies to JSON output]
With **Hide personal info** on (the default, `/settings` → **General → Privacy**), `json` and `stream-json` output is redacted like the UI: your home folder becomes `~`, account emails become `Claude Account 1`, and a username of 5 or more characters becomes `user`, **including inside the model's reply**. If a script needs exact paths, turn privacy off. Plain `text` output of the reply isn't redacted.
:::

## Permissions

Nobody is there to answer a prompt, so **anything that would ask is denied**. The model is told the user denied it and to ask how to proceed, and it usually explains what it couldn't do in its reply. Questions from `ask_user` get "Nobody is here to answer (headless run): make reasonable assumptions…".

| `--permission-mode` | What runs |
|---|---|
| `ask` | Reads, searches, web tools, [read-only commands](../permissions/#read-only-commands), scratchpad writes, and anything an allow rule or a PreToolUse hook approves. Everything else is denied. |
| `auto` | All of that, plus whatever the decision model approves at 0.85 or higher. The rest is denied. |
| `bypass` | Everything except deny rules, sensitive file paths outside the project, and hook blocks. |
| `plan` | Read-only exploration. The result is the plan (see below). |

:::danger[Omitting --permission-mode uses your interactive setting]
Without `--permission-mode`, a headless run uses `toolApproval` from `~/.rein/config.json`, whatever you last picked in `/settings` → **General → Approvals**. If that's `bypass`, **`rein -p` runs every command and file change without asking.** In scripts and CI, always pass `--permission-mode` explicitly.
:::

`--allowedTools` and `--disallowedTools` take the same [rule syntax](../permissions/#rule-syntax) as settings files and are combined with them. Deny still wins, and a deny in your settings beats an `--allowedTools` allow:

```sh
rein -p "bump the patch version and run the tests" \
  --permission-mode ask \
  --allowedTools "edit(package.json),shell(npm test:*),shell(npm version patch)" \
  --disallowedTools "shell(git push:*)"
```

## Plan mode

`--permission-mode plan` turns on [plan mode](../plans/): the agent explores read-only, then calls `present_plan`. With nobody to approve it, the plan is saved to `.rein/plans/` and becomes the run's output, formatted as:

```markdown
# Migrate from Jest to Vitest

…approach, steps, risks, verification…

## Milestones
1. Vitest installed and configured; `npx vitest run` executes
2. All test files converted; suite passes
3. Jest dependencies and config removed
```

In `text` mode the plan is printed after the agent's reply. In `json` mode it replaces `result`. Nothing in the project changes. Your configured approval mode still governs commands that aren't on the read-only list: they're denied, or refused outright under `bypass`. Start the saved plan later in the TUI with `/goal:plan`.

## Exit codes

| Code | When |
|---|---|
| `0` | The run completed. Denied tool calls don't count as failure. |
| `1` | No prompt, no accounts, an invalid `--permission-mode`, or an error during the run (routing failed, every account unavailable, a `UserPromptSubmit` hook blocked the prompt, a [budget](../cost/#budgets) was reached, …). |

To fail a CI step on the *content* of the answer, check `result` yourself (see the example below).

## Tuned for one-off runs

`rein -p` turns on a few [experiments](../../reference/configuration/#experiments) that pay off on a single unattended task: rarely needed tools behind one `tool` entry (`lazy-tools`), no task list (`no-todo`), a short final reply (`brief-final`), compaction at 200K tokens (`context-cap`), a 5-minute Claude prompt cache (`cache-5m`, cheaper to write when nothing pauses) and a check of every requirement before it finishes (`verify-requirements`). Put `-name` in `experiments` to turn one off.

## Hooks in headless runs

Your [hooks](../hooks/) all run. `SessionStart` fires with `source: "resume"` when you use `-c`. A `Stop` hook can send the agent back to work up to 10 times. This also means a repository's own hooks run in CI.

## The Rein GitHub Action

The repo ships a composite action, so a workflow runs Rein in one step, on GitHub's hosted runners with an Anthropic API key or on a self-hosted runner where Rein is signed in:

```yaml title=".github/workflows/rein-review.yml"
name: Rein review
on: pull_request

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: DarKnight1346/rein-harness@main   # pin a commit SHA in real workflows
        id: rein
        with:
          prompt: Review the changes on this branch against origin/${{ github.base_ref }}. List real bugs and risky changes only, most severe first. End with VERDICT: OK or VERDICT: CHANGES.
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          permission-mode: ask
      - if: ${{ !contains(steps.rein.outputs.result, 'VERDICT: OK') }}
        run: exit 1
```

| Input | Default | Meaning |
|---|---|---|
| `prompt` | (required) | What to ask. |
| `anthropic-api-key` | `''` | An Anthropic API key from a secret. Empty on a self-hosted runner where Rein is signed in. |
| `permission-mode` | `ask` | `ask` (read-only), `auto`, `bypass` or `plan`. |
| `model` | `''` | A model ref or `auto`; empty for the default. |
| `allowed-tools` | `''` | Rules that run without asking, like `shell(npm test:*),edit(src/**)`. |
| `version` | `latest` | The `rein-harness` version to install. |
| `working-directory` | `.` | Where to run. |
| `post-comment` | `false` | On a pull request, post the reply as a PR comment (with the model and cost). The job needs `permissions: pull-requests: write`. |

**A reviewer on every PR:** with `post-comment: true`, the prompt above and `permission-mode: ask` (read-only), the action leaves its review as a comment on each pull request. Give the job `permissions: {contents: read, pull-requests: write}`.

Outputs: `result` (the final reply), `is-error`, and `cost-usd` (at API list prices). The reply is also written to the job summary. The action installs Node 22, `rein-harness` and Claude Code when they're missing, and fails the step when the run fails.

With a key, the action sets `REIN_ENV_KEYS=1`: for that run only, Rein uses `ANTHROPIC_API_KEY` from the environment through the official `claude` CLI, in a fresh config folder, and never saves it. Codex can't use a key from the environment this way yet.

## GitLab CI component

`templates/rein.yml` is a [GitLab CI/CD component](https://docs.gitlab.com/ci/components/) with inputs `prompt`, `stage` (`test`), `permission-mode` (`ask`), `model`, `version` (`latest`) and `image` (`node:22`). Set `ANTHROPIC_API_KEY` as a masked CI/CD variable; the job runs `rein -p` with `REIN_ENV_KEYS=1` and keeps `rein-result.json` as an artifact.

```yaml title=".gitlab-ci.yml"
include:
  - component: $CI_SERVER_FQDN/<group>/rein-harness/rein@<version>
    inputs:
      prompt: Review this merge request's changes and list real bugs only.
```

## GitHub Actions example

Without the action: Rein drives your subscription CLIs, so the job needs a machine where Rein is installed and signed in, such as a self-hosted runner where you've run `rein` once.

```yaml title=".github/workflows/rein-review.yml"
name: Rein review
on: pull_request

jobs:
  review:
    runs-on: self-hosted        # rein installed and signed in on this machine
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Review the diff
        run: |
          git diff "origin/${{ github.base_ref }}...HEAD" \
            | rein -p "Review this pull request diff. List real bugs and risky changes only, most severe first. End with VERDICT: OK or VERDICT: CHANGES." \
                --permission-mode ask \
                --output-format json > review.json
          jq -r '.result' review.json >> "$GITHUB_STEP_SUMMARY"

      - name: Fail on requested changes
        run: |
          jq -e '.is_error == false and (.result | test("VERDICT: OK"))' review.json > /dev/null
```

With `--permission-mode ask` the reviewer can read the checkout, search it and run read-only commands such as `git log` and `git show`, but it can't change anything.

## Gotchas

- **Flag values can't start with `-`.** `rein -p "-v is broken"` doesn't see a prompt. Pipe it in instead: `echo "-v is broken" | rein -p`.
- **`-c` without an id** continues the newest conversation in the current folder, with no picker. If there isn't one, it starts fresh.
- **MCP servers connect in the background**, so a very short run can finish before a slow server's tools show up. Project servers from `.mcp.json` only connect once approved (`enabledMcpjsonServers` in `.rein/settings.local.json`).
- **Subagents' approval requests are denied too.** Give the rules they need with `--allowedTools`.
- **Plan mode writes one file:** the plan in `.rein/plans/`.
- **Nobody can answer a command's questions.** A command the agent runs with `interactive: true` still gets a terminal, but if it waits for input it's stopped after a couple of seconds and the agent is told nobody can answer.

## Related

- [Permissions](../permissions/): rules, modes and the full pipeline
- [Plans](../plans/)
- [Hooks](../hooks/)
- [CLI reference](../../reference/cli/)
- [Routing](../routing/): what `--model auto` does
