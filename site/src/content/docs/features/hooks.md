---
title: Hooks
description: Run your own commands at key moments — before and after tool calls, on every prompt, when the agent stops, at session start — using Claude Code's hooks format.
---

Hooks are shell commands Rein runs at fixed points in the agent's work. A hook can veto a tool call, approve one, feed the model extra context, or send it back to work. Rein reads Claude Code's `hooks` block from the same settings files, so most existing hooks carry over. The [differences](#differences-from-claude-code) are listed below; check them before reusing a script.

```json title=".rein/settings.json"
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": "\"$REIN_PROJECT_DIR\"/.rein/hooks/no-push.sh"}]
      }
    ]
  }
}
```

```text title="rein"
⏺ Shell($ git push origin main)
  blocked by a PreToolUse hook: git push is disabled here — ask the user to push.
```

## Trusting a project's hooks

Hooks in your own settings (`~/.claude/settings.json`, `~/.rein/settings.json`) always run. Hooks that come with a **project** (`.claude/settings.json`, `.claude/settings.local.json`, `.rein/settings.json`, `.rein/settings.local.json`) run only after you trust them, so a repo you clone can't run commands just because you started `rein` in it.

The first time Rein sees a project's hooks, it lists every command and asks:

```text title="rein"
╭ This project defines hooks ──────────────────────────────────────────╮
│ Its settings files run these commands automatically (on start, on     │
│ prompts, around tool calls):                                          │
│                                                                       │
│   SessionStart     ./scripts/dev-context.sh · .claude/settings.json   │
│   PreToolUse       ./scripts/no-push.sh · .claude/settings.json       │
│                                                                       │
│ 1 Trust these hooks and run them (y)                                  │
│ 2 Don't run them (n / esc · you'll be asked again next time)          │
╰───────────────────────────────────────────────────────────────────────╯
```

- **Trust** runs them from then on, starting with any `SessionStart` hooks that were held back.
- **Don't run them** keeps them off for this session and asks again next launch.
- **Any change asks again.** The trust covers the hooks exactly as you reviewed them, as a hash stored in `~/.rein/state/trusted-projects.json`. If a `git pull`, a teammate or the agent itself changes them, they stop running and Rein asks again, even mid-session.
- **Headless runs** (`rein -p`) can't ask, so untrusted project hooks are skipped with a note on stderr. Run `rein` in the folder once to review and trust them.

## Events

| Event | When | Can it block? | Output goes to |
|---|---|---|---|
| `PreToolUse` | Before every tool call, after deny rules | Yes: refuse the call. It can also approve it or force a prompt. | The model (block reason) |
| `PostToolUse` | After a tool runs and returns a result (not when the call errors out, e.g. an `edit` whose `old_string` isn't found) | No (already ran), but its feedback reaches the model | Appended to the tool result |
| `UserPromptSubmit` | Before each message is sent to the model | Yes: the message isn't sent | The model (as context), or you (block reason) |
| `Stop` | After the agent finishes a reply | Yes: it keeps working | The model (as its next instruction) |
| `SessionStart` | Once, when Rein starts (fresh or resumed) | No | The model (context on the first message) |

`UserPromptSubmit` also runs for skill turns and Stop-hook continuations, because they're messages too. `SessionStart` runs once per launch, not on `/clear` or `/resume`.

## Configuration

Hooks go under a top-level `hooks` key in any of the six settings files [permissions](../permissions/#where-rules-come-from) use:

1. `~/.claude/settings.json`
2. `~/.rein/settings.json`
3. `<project>/.claude/settings.json`
4. `<project>/.claude/settings.local.json`
5. `<project>/.rein/settings.json`
6. `<project>/.rein/settings.local.json`

Every file's groups are combined, in that order (no file overrides another). The files are re-read each time an event fires, so edits apply immediately.

```json
{
  "hooks": {
    "<Event>": [
      {
        "matcher": "<regex over tool names>",
        "hooks": [
          {"type": "command", "command": "<shell command>", "timeout": 60}
        ]
      }
    ]
  }
}
```

- Only `"type": "command"` is supported.
- `timeout` is in **seconds** (default 60). A hook that runs over is killed and treated as if it didn't run.
- Commands run one after another in the order listed. The first one that blocks stops the rest.

### Matchers

`matcher` applies to the tool events (`PreToolUse`, `PostToolUse`). It's a regular expression matched against the **whole** tool name: `Edit` matches `Edit`, not `NotebookEdit`. Leave it out, or use `"*"`, to match everything. An invalid regex is compared as a plain name. The other events ignore `matcher`.

A matcher is tried against Rein's tool name **and** its Claude Code names, so matchers written for Claude Code keep working:

| Rein tool | Also matches |
|---|---|
| `shell` | `Bash` |
| `edit` | `Edit`, `MultiEdit` |
| `write` | `Write` |
| `read` | `Read` |
| `search` | `Grep` |
| `list` | `Glob`, `LS` |
| `web_fetch` | `WebFetch` |
| `web_search` | `WebSearch` |
| `agent` | `Task` |
| `todo_write` | `TodoWrite` |

Other tools match by their Rein name: `delete`, `image_generate`, `mcp_add`, and MCP tools as `mcp__<server>__<tool>` (so `mcp__github__.*` matches a whole server). Hooks fire for subagents' tool calls too.

## Input: JSON on stdin

Every hook gets one JSON object on stdin. Every event includes `hook_event_name` and `cwd` (the project root).

```json title="PreToolUse"
{
  "hook_event_name": "PreToolUse",
  "cwd": "/home/you/code/app",
  "tool_name": "shell",
  "session_id": "…",
  "tool": "shell",
  "tool_input": {"command": "git push origin main"}
}
```

| Event | Fields |
|---|---|
| `PreToolUse` | `session_id`, `tool_name`, `tool` (both the Rein name), `tool_input` (the call's arguments) |
| `PostToolUse` | The same, plus `tool_response: {"ok": true, "text": "…"}` (text capped at 20,000 characters) |
| `UserPromptSubmit` | `session_id`, `prompt` |
| `Stop` | `session_id`, `stop_hook_active` (`true` while continuing because of a Stop hook) |
| `SessionStart` | `source`: `"startup"` or `"resume"` (no `session_id`) |

`tool_input` uses **Rein's argument names**. For `shell` that's `command`, `background`, `timeout_ms` and `cwd`. For `write`, `edit`, `delete` and `read` the file is `path`, not Claude Code's `file_path`. The full list is in the [tools reference](../../reference/tools/).

## Output: exit codes and JSON

| Hook result | Effect |
|---|---|
| Exit **0** | Success. Stdout is checked for JSON (below). |
| Exit **2** | **Block.** Stderr is the reason: the model gets it for tool events and Stop, and you see it for `UserPromptSubmit`. |
| Any other exit code, or a timeout | Ignored: nothing is blocked, and nothing is shown. |

On exit 0, stdout that **starts with `{`** is parsed as JSON:

```json
{"decision": "block", "reason": "…"}
```

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "…",
    "additionalContext": "…"
  }
}
```

| Field | Effect |
|---|---|
| `decision: "block"` or `permissionDecision: "deny"` | Block, with `permissionDecisionReason` or `reason` as the message. |
| `permissionDecision: "allow"` or `decision: "approve"` | **PreToolUse:** run without prompting (`· allowed by hook`). |
| `permissionDecision: "ask"` | **PreToolUse:** show the approval prompt for a file change, command or other mutating call, even in bypass mode, after a session allow, or when a rule allows it. |
| `additionalContext` | Text added to the model's context. |

Plain (non-JSON) stdout becomes context for `UserPromptSubmit` and `SessionStart`. It's ignored for the other events.

What a block or context does, per event:

- **PreToolUse block:** the call fails with `blocked by a PreToolUse hook: <reason>`.
- **PostToolUse** block reason or context is appended to the tool result as `[PostToolUse hook] …` / `[PostToolUse hook context] …`.
- **UserPromptSubmit block:** the message isn't sent, and you see `Blocked by a UserPromptSubmit hook: <reason>`. Context is appended to your message inside `<hook_context>`.
- **Stop block:** Rein shows `Stop hook: <reason>` and sends the agent `<stop_hook>…</stop_hook> Continue working.` This happens at most **10 times in a row**, interactive or headless. When no Stop hook blocks, Rein's own [code check](../code-intelligence/#what-the-agent-gets) runs next.
- **SessionStart** context is attached to the first message of the session.

:::caution[What a PreToolUse "allow" skips]
A hook's allow comes **after** deny rules (a deny rule still wins) and doesn't lift plan mode's ban on file changes. It does skip every prompt after that, **including the outside-the-project and sensitive-path prompts**. Write allow hooks narrowly.
:::

## Environment

Hooks run in the project root, with Rein's environment plus:

| Variable | Value |
|---|---|
| `REIN_PROJECT_DIR` | The project root |
| `CLAUDE_PROJECT_DIR` | The same, so Claude Code hooks find their scripts |

**Shell:** `/bin/sh -c` on macOS and Linux. On Windows, Rein uses **Git Bash** when it's installed (found via `REIN_GIT_BASH_PATH`, `CLAUDE_CODE_GIT_BASH_PATH` or the standard install paths), the same as the agent's shell, so bash-syntax hooks work. Otherwise it uses PowerShell.

## Recipes

These recipes use [`jq`](https://jqlang.org/) to read the input. The scripts are run directly, so make them executable once:

```sh
chmod +x .rein/hooks/*.sh
```

### Block `git push`

```sh title=".rein/hooks/no-push.sh"
#!/bin/sh
cmd=$(jq -r '.tool_input.command // empty')
case "$cmd" in
  *"git push"*)
    echo "git push is disabled here — ask the user to push." >&2
    exit 2 ;;
esac
exit 0
```

```json title=".rein/settings.json"
{
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "\"$REIN_PROJECT_DIR\"/.rein/hooks/no-push.sh"}]}
    ]
  }
}
```

A `shell(git push:*)` deny rule already catches `git push` after `&&` or `;`. The hook also catches the forms a deny rule misses: inside `$( … )` or backticks, behind `sudo`, or as `/usr/bin/git push`.

### Format files after every edit

```sh title=".rein/hooks/format.sh"
#!/bin/sh
f=$(jq -r '.tool_input.path // empty')
case "$f" in
  *.ts|*.tsx|*.js|*.json|*.md)
    npx --no-install prettier --write "$f" >/dev/null 2>&1 &&
      printf '{"hookSpecificOutput":{"additionalContext":"Formatted %s with prettier; read it again before editing it further."}}' "$f" ;;
esac
exit 0
```

```json title=".rein/settings.json"
{
  "hooks": {
    "PostToolUse": [
      {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "\"$REIN_PROJECT_DIR\"/.rein/hooks/format.sh", "timeout": 30}]}
    ]
  }
}
```

The `additionalContext` line matters. Rein's [stale-file protection](../tools/#stale-file-protection) notices that the formatter changed the file and refuses the next edit until the agent re-reads it, so telling the agent up front saves a failed edit.

### Inject context at session start

```json title=".rein/settings.json"
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {"type": "command", "command": "echo \"Branch: $(git branch --show-current)\"; echo 'Recent commits:'; git log --oneline -5"}
        ]
      }
    ]
  }
}
```

Plain stdout becomes context, so the agent's first message arrives already knowing the branch and recent history.

### Don't stop until the tests pass

```sh title=".rein/hooks/tests-green.sh"
#!/bin/sh
# Only push back once; on a continuation, let the agent stop.
[ "$(jq -r '.stop_hook_active')" = "true" ] && exit 0
npm test --silent >/dev/null 2>&1 && exit 0
echo "The test suite is failing. Run npm test, fix the failures, then finish." >&2
exit 2
```

```json title=".rein/settings.json"
{
  "hooks": {
    "Stop": [
      {"hooks": [{"type": "command", "command": "\"$REIN_PROJECT_DIR\"/.rein/hooks/tests-green.sh", "timeout": 600}]}
    ]
  }
}
```

Checking `stop_hook_active` keeps the hook from bouncing the agent back to work over and over. Set a `timeout` longer than your test suite: a hook that times out counts as not having run, so the agent would stop without the message. A Stop hook fires after **every** reply, one-line answers included, so keep the check fast or skip it when nothing changed (e.g. `git diff --quiet && exit 0`).

## Differences from Claude Code

- **`tool_name` is Rein's name** (`shell`, `edit`), and `tool_input` uses Rein's fields (`path`, not `file_path`). Matchers accept both naming schemes, but a script that tests `tool_name == "Bash"` or reads `.tool_input.file_path` needs updating. To support both: `jq -r '.tool_input.file_path // .tool_input.path'`.
- **Events:** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `SessionStart`. Others (`Notification`, `SubagentStop`, `PreCompact`, `SessionEnd`) never fire.
- **Payloads** don't include `transcript_path` or `permission_mode`.
- **JSON fields** other than those listed above (`continue`, `stopReason`, `suppressOutput`, …) are ignored.
- **Failures are silent:** a hook that exits 1 or times out doesn't block and isn't reported.

## Related

- [Permissions](../permissions/): where hooks sit in the pipeline
- [Tools reference](../../reference/tools/): the `tool_input` fields for every tool
- [Headless mode](../headless/): Stop hooks in scripts
- [Coming from Claude Code](../../start/from-claude-code/)
