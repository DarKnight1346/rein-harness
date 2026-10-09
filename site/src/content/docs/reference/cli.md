---
title: CLI flags
description: Every flag the rein command accepts, including headless mode for scripts and CI, and the environment variables that change Rein's behavior.
---

```sh
rein [--continue|-c [id]] [--classic|--fullscreen] [--add-dir <path>]...
rein -p "<prompt>" [--model m] [--effort e] [--output-format text|json|stream-json]
                   [--permission-mode ask|auto|bypass|plan] [--allowedTools …] [--disallowedTools …]
                   [-c [id]] [--verbose]
rein --update | --version | --help
```

Run `rein` from the project folder you want to work in. That folder becomes the agent's working directory.

## Interactive flags

| Flag | What it does |
|---|---|
| *(none)* | Starts Rein in the current folder with your configured renderer (fullscreen by default). |
| `-c`, `--continue` | Opens a picker of this project's saved conversations. |
| `-c <id>`, `--continue <id>` | Continues that conversation directly. |
| `--classic` | Inline renderer: native terminal scrollback, no mouse, no sidebar. |
| `--fullscreen` | App-style renderer: top bar, sidebar, windows, mouse. This is the default. |
| `--add-dir <path>` | Lets the agent also use this folder without asking, for this session. Repeatable. |
| `--update` | Updates Rein and the `claude` / `codex` CLIs, prints the steps, then exits (no TTY needed). Exits `1` if a step failed. |
| `-v`, `--version` | Prints Rein's version. |
| `-h`, `--help` | Prints usage. |

`--classic` / `--fullscreen` override the renderer for this run only. `/tui` inside Rein switches and remembers your choice.

```sh
rein                        # fullscreen, new conversation
rein -c                     # pick a conversation to continue
rein --classic              # inline renderer
rein --add-dir ../shared --add-dir ~/notes
rein --update
```

:::note
Interactive Rein needs a terminal. Run without one (in a pipe or CI) and it exits with `rein needs an interactive terminal (or use rein -p "…" for headless mode).`
:::

## Headless mode: `rein -p`

`-p` / `--print` runs one prompt with no UI and prints the result. It uses the same routing, failover, tools, permission rules and hooks as the TUI. See [Headless & CI](../../features/headless/) for recipes.

| Flag | Values | What it does |
|---|---|---|
| `-p`, `--print` | `"<prompt>"` | The prompt. Piped stdin is appended to it, or used alone if `-p` has no text. |
| `--model` | `auto` or a model ref | Chat model for this run only. |
| `--effort` | a level (`low`, `medium`, `high`, `xhigh`, `max`…), `auto` or `default` | Effort for this run only. Levels the model doesn't support are clamped. |
| `--output-format` | `text` *(default)*, `json`, `stream-json` | How the result is printed (see below). |
| `--permission-mode` | `ask`, `auto`, `bypass`, `plan` | How approvals are handled. Defaults to your `/settings` → Approvals setting. |
| `--allowedTools` | comma-separated rules | Extra allow rules for this run, such as `"shell(npm test:*),edit(src/**)"`. |
| `--disallowedTools` | comma-separated rules | Extra deny rules for this run. Deny wins. |
| `-c`, `--continue` | `[id]` | Continues the **latest** conversation in this project, or the given one. No picker. |
| `--verbose` | — | Text mode: prints tool calls (`⏺ Edit(src/a.ts) ✓`) and notices to stderr. |
| `--add-dir` | `<path>` | Lets the agent also use this folder without asking, for this run. Repeatable; adds to `additionalDirectories`. |

Settings passed on the command line apply to this run only. They're never saved to `config.json`.

### Permission modes

There is no one to ask in headless mode, so anything that would need your yes is **refused** unless something allows it:

| Mode | Behavior |
|---|---|
| `ask` | Refuses anything that would need approval. Saved rules, `--allowedTools` and hooks can still allow calls. |
| `auto` | The decision model approves changes that clearly match the prompt. The rest is refused. |
| `bypass` | Allows every change, except credentials and secrets outside the project. |
| `plan` | Read-only exploration. The agent's plan is the result, and nothing is changed. |

:::caution
`--permission-mode` defaults to your configured approval mode, not to `ask`. If you set **Bypass** in `/settings`, `rein -p` runs in bypass too. Pass `--permission-mode` explicitly in scripts.
:::

### Output formats

- **`text`**: the reply streams to stdout. Errors go to stderr as `rein: …`.
- **`json`**: one JSON object when the run ends:

  ```json
  {"type":"result","is_error":false,"result":"…","session_id":"2026-10-03-14-05-12-3f9a",
   "model":"claude:…","effort":"high","tools":[{"tool":"Edit","summary":"src/a.ts","ok":true}],
   "tokens":{…},"duration_ms":18234}
  ```

  On failure: `{"type":"result","is_error":true,"error":"…"}`.
- **`stream-json`**: one JSON event per line as the run progresses (`route`, `tool` start/end, `text` deltas, notices), then the same final `result` object.

Exit code is `0` on success and `1` on error. If a `Stop` hook sends the agent back to work, Rein continues, up to 10 times.

### Examples

```sh
rein -p "summarize the README"
git diff | rein -p "review this diff" --output-format json
rein -p "fix the failing tests" --permission-mode auto --allowedTools "shell(npm test:*),edit(src/**)"
rein -p "plan a migration to ESM" --permission-mode plan
rein -p "now add docs" -c --output-format stream-json --verbose
```

:::note
Headless mode needs at least one account: run `rein` once to import or add one.
:::

## Environment variables

| Variable | What it does |
|---|---|
| `REIN_HOME` | Where Rein keeps its data. Default `~/.rein`. |
| `REIN_NO_AUTOUPDATE` | Set to anything to skip the update check on launch. |
| `REIN_NO_BROWSER` | Don't open a browser for logins. Rein shows the URL to visit instead. |
| `REIN_NO_USAGE_REFRESH` | Turns off the background usage refresh. |
| `REIN_CLAUDE_BIN` | Path to the `claude` executable. Default: `claude` on your PATH. |
| `REIN_CODEX_BIN` | Path to the `codex` executable. Default: `codex` on your PATH. |
| `REIN_GIT_BASH_PATH`, `CLAUDE_CODE_GIT_BASH_PATH` | Windows: the Git Bash used for the agent's shell and hooks. |
| `TYPESAFE_API_KEY` | Jev API key. Takes priority over a key saved with `/login`. |
| `TYPESAFE_BASE_URL` | Jev API base URL. Default `https://api.typesafe.ai`. |

Rein clears `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` from the environment of the CLIs it starts. Accounts therefore always run on their subscription login, never on a stray API key.

Hooks receive `REIN_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`. See [Hooks](../../features/hooks/).

## Related

- [Headless & CI](../../features/headless/)
- [Files & environment](../files/)
- [Slash commands](../commands/)
