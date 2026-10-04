---
title: Tools
description: The one tool set every model in Rein gets — files, search, shell, web, images, planning, memory, subagents and MCP — implemented once and enforced in one place.
---

Claude and Codex in Rein work with the **same** tools. They aren't two lookalike sets: there's a single implementation, a single permission check and a single transcript format, so switching models mid-conversation doesn't change what the agent can do or how it asks you.

```text title="rein"
⏺ Search(handleLogin in src (*.ts))
  src/auth/login.ts:42:export async function handleLogin(req: Request) {
⏺ Read(src/auth/login.ts)
⏺ Edit(src/auth/login.ts) · you approved
  - if (!user) return null;
  + if (!user) throw new AuthError('unknown user');
⏺ Shell($ npm test) · allowed by rule
```

## One implementation, two providers

- **Claude** runs as `claude -p` with its built-in tools switched off (`--tools ""`) and its settings sources disabled. Rein's tools reach it through a small MCP proxy (named `rein`) that forwards each call over a local socket to the Rein process.
- **Codex** runs through `codex app-server`, with Rein's tools passed in as dynamic tools. Its threads use `sandbox: read-only` and `approvalPolicy: untrusted`, so Codex's own machinery can't write anything.

In both cases the call lands in Rein's `ToolHost`, which applies your [permissions](../permissions/), runs [hooks](../hooks/), checkpoints files for [/rewind](../rewind/), and draws the line in the transcript.

## The tool set

Parameters for every tool are in the [tools reference](../../reference/tools/).

### Files

| Tool | What it does |
|---|---|
| `read` | Reads a file with `cat -n`-style line numbers, 2000 lines at a time (`offset` / `limit`). Images go to the model **as images**; PDFs come back as text, page by page. See [Web & images](../web-and-images/#reading-images-and-pdfs). |
| `list` | Tree view, folders first, files with sizes. `depth` 1–5. Hidden entries and `.git`, `node_modules`, `dist`, `build`, `.next`, `.venv`, `__pycache__` are skipped unless `all: true`. Capped at 500 entries. |
| `write` | Creates or overwrites a file, creating parent folders as needed. |
| `edit` | Exact string replacement. `old_string` must be unique unless `replace_all`. Files over 8 MB are edited by streaming, so memory use stays constant. |
| `delete` | Deletes a file or folder (non-empty folders need `recursive: true`). It refuses to delete the project root. |

File changes show up in the transcript as a colored diff.

### Search

| Tool | What it does |
|---|---|
| `search` | Regex over file contents (`path:line:text`), or over file paths with `files_only`. Narrow with `path` and `glob`. Uses the bundled ripgrep (respects `.gitignore`), then `rg` on your PATH, then a built-in JavaScript fallback. Up to 200 results. |

### Shell

| Tool | What it does |
|---|---|
| `shell` | Runs a command, in the foreground (waits) or with `background: true`. |
| `shell_logs` | Reads a shell's recent output, or lists all shells. |
| `shell_kill` | Stops a shell and everything it started. |

See [Shell behavior](#shell-behavior) below.

### Sessions

| Tool | What it does |
|---|---|
| `sessions_search` | Regex search over saved conversations, messages and tool calls included, newest first. This project by default; `all_projects: true` searches everything. |
| `session_read` | Reads a saved conversation by id, 30 messages per page. |

The agent can look up "what did we decide about the cache last week?" for itself.

### Web

| Tool | What it does |
|---|---|
| `web_search` | Runs on your **Web** model using that provider's native search, so it works with any chat model. |
| `web_fetch` | Fetches a page locally, converts it to markdown, and returns it in pages or answers a `prompt` about it. |

Details in [Web & images](../web-and-images/).

### Images

| Tool | What it does |
|---|---|
| `image_generate` | Codex's image generation, available to **every** model, Claude included. It only appears while a Codex account that can generate images is signed in. |

### Interaction & planning

| Tool | What it does |
|---|---|
| `ask_user` | Asks you up to 6 multiple-choice questions at once (2–8 options each, plus "Something else" for your own answer). |
| `todo_write` | Keeps the task list shown in the sidebar. |
| `present_plan` | In plan mode, presents the plan and its milestones for your approval. See [Plans](../plans/). |
| `milestone_done`, `goal_done` | Report progress on a [goal](../goals/), with evidence the decision model checks. |

### Memory

| Tool | What it does |
|---|---|
| `remember`, `forget` | Maintain the project memory in `.rein/MEMORY.md`. See [Memory](../memory/). |

### Models & helpers

| Tool | What it does |
|---|---|
| `agent`, `agent_result` | Spawn [subagents](../subagents/) (fork the conversation, or start fresh on any model) and collect their reports. |
| `advisor` | Ask a stronger model for advice. Only listed when an advisor is set in `/model` (off by default). |
| `decide` | Hand small judgments (yes/no, pick one, score) to the cheap decision model, up to 25 questions per call. |
| `skill` | Load a [skill](../skills/) when the request matches one. |

### MCP management

| Tool | What it does |
|---|---|
| `mcp_list` | Servers, status, tools. |
| `mcp_add` | Adds and connects a server. It asks you first in ask and auto modes. |
| `mcp_remove` | Removes a server from `.mcp.json` or `~/.rein/mcp.json`. |
| `mcp_call` | Calls a server's tool right away, before it shows up as a direct tool on the next message. |

Server tools themselves appear as `mcp__<server>__<tool>`. See [MCP](../mcp/).

:::note[Main agent only]
`agent`, `agent_result`, `ask_user`, `todo_write`, `present_plan`, `milestone_done` and `goal_done` belong to the main agent. Subagents get everything else and can't spawn subagents of their own.
:::

## Stale-file protection

Rein won't let a model edit from memory. To change an existing file with `write` or `edit`, the agent must have **read it in this conversation**, and it must be **unchanged since**:

```text title="rein"
⏺ Edit(src/config.ts)
  src/config.ts changed since you last read it (edited outside this conversation, or by a command) — read it again, then redo the change
```

That catches the cases that actually bite: you edited the file in your editor while the agent worked, a formatter or codegen step rewrote it, or the agent is guessing at contents it never saw. Rein compares modification time and size; its own writes update the record, so consecutive edits work. The scratchpad is exempt.

## Project confinement

File tools resolve every path, following symlinks, and only touch your **working directories** without asking: the project, the session scratchpad, `~/.rein/skills`, `additionalDirectories`, and anything added with `/add-dir` or `--add-dir`. A path anywhere else triggers an "outside the project" prompt first. Credential locations such as `~/.ssh` and `~/.aws` only ever get a one-time yes. The rules are in [Permissions](../permissions/#working-directories).

Two details make this hard to slip past:

- Symlinks are resolved on the nearest existing ancestor before the check, so `link → /etc` inside your project counts as `/etc`.
- Files are opened with `O_NOFOLLOW` after the check. If something swaps the file for a symlink in between (a background shell, say), the write fails instead of following it. Windows has no `O_NOFOLLOW`, so Rein checks for a symlink explicitly there.

:::caution
Confinement applies to the **file tools** and to the shell's working directory. The commands a shell runs aren't sandboxed: `shell` can do whatever your user account can, which is why it's a mutating tool that goes through approval.
:::

## Shell behavior

**Foreground** commands (the default) block the tool call while you watch the output live. The default timeout is **2 minutes**; the agent can raise it per command with `timeout_ms`, up to your cap in `/configure` → **Shell** (10, 30, 60, 120, 240 or 480 minutes, or no limit; default **120 minutes**, saved as `shellMaxMinutes`). The agent gets the last 2000 lines (at most 30,000 characters) plus the exit status:

```text title="rein"
[exit 0 after 14s]
 ✓ 128 tests passed
```

**Background** commands (`background: true`) return an id immediately and have no timeout. They're meant for dev servers and watchers. The agent reads them with `shell_logs` and stops them with `shell_kill`, and the status line shows `● 1 background (/shells)`. They keep running until the agent stops them or Rein exits, so when a turn ends Rein also mentions, once, any background command that has been running for 5 minutes or more (`Still running in the background: #3 gmake run (2h 41m)…`). After an hour (`backgroundCheckMinutes`, default 60), Rein forks the agent the way [`/btw`](../btw/) does, so it sees the full conversation with read-only tools while the main turn keeps going. The fork is asked whether the command is still needed, given its recent output. If the answer is no, Rein stops it and says why (`Stopped background #3 gmake run after 1h 2m: the agent no longer needs it (…)`). If yes or unsure, the command keeps running and is checked again an hour later.

Every command runs:

- with **no stdin and no TTY**, so interactive prompts fail fast (the agent is told to pass `--yes`-style flags);
- with `CI=1` (unless you already set `CI`), `PAGER=cat`, `GIT_PAGER=cat` and `FORCE_COLOR=0`;
- with ANSI codes stripped and `\r` progress bars collapsed to their final state, keeping the last 5000 lines while it runs and the last 2000 once it ends (only the 50 most recent finished commands keep output). Output that never sends a newline, like a firmware console or a spinner, is cut into lines so it can't grow without bound;
- in its own process group, so stopping it takes down its children. Stopping sends SIGTERM, then SIGKILL after 3 seconds.

Pressing Esc or Ctrl+C to interrupt the agent also kills its foreground command. Background shells keep running until stopped or until you quit Rein.

### `/shells`

`/shells` lists every command the agent started, with status and duration. `/shells <id>` opens one's logs. When you're viewing a subagent, you see the shells *it* started.

```text title="rein"
#1 background · running 4m 12s · npm run dev
#2 foreground · exit 0 after 14s · npm test
/shells <id> shows logs
```

### Which shell

- **macOS / Linux:** `$SHELL -c` (falling back to `/bin/sh`).
- **Windows:** **Git Bash** when it's installed, so commands use bash syntax as in Claude Code. Rein looks at `REIN_GIT_BASH_PATH`, then `CLAUDE_CODE_GIT_BASH_PATH`, then the standard install locations (`Program Files`, `Program Files (x86)`, `%LOCALAPPDATA%\Programs\Git`), then `bash.exe` next to `git` on your PATH. Without Git Bash it falls back to **PowerShell** (`-NoProfile -NonInteractive`), and the tool's description tells the model which one it has.

## Limits worth knowing

- Every tool result is capped at 60,000 characters before it reaches the model.
- `read` truncates lines longer than 2000 characters and reports binary files instead of dumping them.
- The first time the agent works in a subfolder that has its own `AGENTS.md` or `CLAUDE.md`, those instructions are attached to the tool result, scoped to that folder. See [Memory](../memory/#scoped-subfolder-instructions).

## Related

- [Tools reference](../../reference/tools/): every parameter
- [Permissions](../permissions/): what asks, and why
- [Web & images](../web-and-images/)
- [MCP](../mcp/): add more tools
- [Subagents](../subagents/)
