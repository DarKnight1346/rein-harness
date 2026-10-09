---
title: Slash commands
description: Every built-in Rein slash command, its arguments and aliases, plus the built-in skills that ship with Rein.
---

Type `/` in the input to see the list. It filters as you type. **Tab** or **Enter** fills in the highlighted entry so you can add arguments, and a command typed out in full runs right away. You can also click an entry in fullscreen. `/help` shows everything, including your skills.

Rein has **26 built-in commands** and **7 built-in skills**. Commands are handled by Rein itself. Skills are prompts sent to the agent (see [Built-in skills](#built-in-skills)).

## While the agent is working

The input stays live while the agent works:

- **Plain messages and skills queue.** They're sent when the current reply finishes, and the working line shows `N queued`.
- **`/btw` runs immediately**, on the side.
- **`/clear`, `/compact`, `/tui`, `/update` and `/resume` wait.** If you run one while the agent is busy, Rein says `/<name> waits until the agent is idle (esc interrupts it).` and does nothing. Press Esc first.
- **`/rewind`** also refuses while the agent is working: `The agent is working — press esc to stop it first, then /rewind.`
- Every other command runs at once.

When you're [viewing a subagent](../../features/subagents/), `/compact`, `/rewind`, `/clear` and `/resume` are refused, because they act on the main conversation. Switch back with `/agent main` first.

In fullscreen, commands that show information open a window over the conversation, which keeps streaming underneath. In the classic renderer the same information is printed into the history.

## Commands

### Conversation

| Command | Arguments | What it does |
|---|---|---|
| `/clear` | — | Clears the conversation and stops every subagent. *Waits for idle.* |
| `/compact` | `[what to keep]` | Summarizes the conversation with the compaction model and keeps the last two messages as-is. With text (`/compact keep the API design decisions`), the summary keeps that in full detail. The agent can bring summarized parts back with `recall`. *Waits for idle.* → [Compaction](../../internals/context/#compaction) |
| `/context` | — | Shows what the context holds and how full it is, as a grid that refreshes every second while open, with the largest items (instruction files, tool results, the summary) listed below it. When viewing a subagent, shows the subagent's context. |
| `/resume` | — | Picks a saved conversation from this project to continue. *Waits for idle.* |
| `/rewind` | — | Restores files and/or the conversation to before one of your messages. Also **Esc Esc** with an empty input. |
| `/btw` | `<question>` | Asks a side question. A fork of the agent answers without interrupting it, and the answer is not added to the conversation. Runs immediately, even mid-reply. |

### Goals and plans

| Command | Arguments | What it does |
|---|---|---|
| `/goal` | `<text>` | Sets a goal. The agent keeps working until the decision model verifies it's done (evidence required). |
| | *(none)* | Shows the current goal: a window in fullscreen, a summary in classic. |
| | `pause` | The current turn finishes, then the agent stops working on the goal. |
| | `resume` | Continues a paused goal. |
| | `clear` | Removes the goal. |
| `/goal:plan` | — | Starts a saved, unfinished plan from `.rein/plans/` as a goal, with milestones tracked in the sidebar. You can also start planning a new one from the same window, which puts `/plan ` in the input. |

See [Goals](../../features/goals/) and [Plan mode](../../features/plans/).

### Models, accounts and usage

| Command | Arguments | What it does |
|---|---|---|
| `/model` | *(none)* | Opens **Models** with sections Chat model, Subagents, Subagent priority, Decision model, Compaction model, Advisor and Web. Choosing a chat model continues to its effort level. |
| | `auto` | Sets the chat model to auto routing. |
| | `<model>` | Sets the chat model. Accepts a `provider:model` ref or a model's id or label as shown in `/model`, case-insensitive. |
| `/voice` | `setup` | [Voice input](../../features/voice/) on your machine (whisper.cpp). Shows what's installed, or, once set up, starts or stops a recording (like a tap of Ctrl+Space). `setup` installs what's missing (Homebrew on macOS) and downloads the speech model (about 60 MB, once). |
| `/remote` | `on` · `pair` · `status` · `unpair` · `off` | Use this session from your phone or another computer: starts a page Rein serves (on this computer only, reach it through a tunnel) and shows a pairing code. → [Remote access](../../features/remote/) |
| `/trackers` | `check` · `retry <ref>` | Issue trackers handing work to Rein (GitHub, Linear, GitLab, Azure DevOps, Jira): what's set up and what's been taken; `check` looks now; `retry` lets an issue be taken again. → [Issue trackers](../../features/trackers/) |
| `/vault` | `set NAME` · `rm NAME` | Secrets the agent can use in shell commands as `$NAME` without seeing them. Lists the names; `set` asks for the value in a hidden field; `rm` removes one. → [Secrets vault](../../features/vault/) |
| `/lsp` | `stop` | Built-in code intelligence: the language servers Rein is running (memory, open files, idle time), and which are installed and where. `stop` shuts them down (they start again when needed). → [Code intelligence](../../features/code-intelligence/) |
| `/plugins` | — | Lists the Claude Code and Codex plugins Rein loaded, and what each adds (commands, agents, hooks, MCP servers), plus Codex skills. → [Plugins](../../features/plugins/) |
| `/login` | — | Lists accounts; adds Claude (subscription, Console API key, Bedrock, Vertex) or Codex (ChatGPT, OpenAI API key) accounts; re-authenticates or removes them; manages the Jev API key. → [Accounts](../../features/accounts/#api-accounts-pay-per-use) |
| `/usage` | *(none)* | Usage windows (5h / weekly / 30-day) and reset times for every account. |
| | `refresh` | Re-checks now. Claude accounts send a tiny request on their cheapest model to get fresh numbers. |

### Agents and shells

| Command | Arguments | What it does |
|---|---|---|
| `/agents` | — | The subagents the agent has spawned. Pick one to view and message it (`k` stops one). Classic prints the list. |
| `/agent` | `<id>` | Fullscreen: switches the main pane to that subagent. Classic: prints its status and report. |
| | `main` *(or none)* | Switches back to the main agent. |
| | `<id> <message>` | Sends a message to that subagent (useful in classic). |
| `/shells` | *(none)* | Shell commands the agent started. Open one to see its logs (`k` kills it). |
| | `<id>` | Opens that shell's logs directly. |

### Project and permissions

| Command | Arguments | What it does |
|---|---|---|
| `/cost` | — | What the conversation, the latest request and the current goal cost at API list prices, with token totals. See [Cost & budgets](../../features/cost/). |
| `/affected` | — | What your working tree's changes affect, from the monorepo's build graph (Nx, Turborepo, Bazel, Pants), and the command that tests just that. See [Build & test](../../features/build-and-test/#what-a-change-affects). |
| `/build` | — | The build system here (Nx, Turborepo, Bazel, Pants), the build caches it's set up with, and whether the sandbox lets agent builds use them. See [Build caches](../../features/build-and-test/#build-caches). |
| `/flaky` | `[clear]` | The tests known to be flaky in this project (they failed and passed on the same code), recorded with the `flaky-quarantine` experiment. `clear` forgets them. See [Flaky tests](../../features/build-and-test/#flaky-tests). |
| `/policy` | — | Shows the policy in force (`.rein/policy.yaml`, `~/.rein/policy.yaml`): its deny and ask rules, allowed and denied models, and mistakes in the files. See [Policy as code](../../features/safety/#policy-as-code-reinpolicyyaml). |
| `/workspace` | `[clone]` | Lists the repos of this [workspace](../../features/workspaces/) (`rein.workspace.yaml`), which are cloned and what each does. `clone` clones the missing repos that have a `url`. |
| `/scope` | `[<dir> \| off]` | Works in one package of a monorepo: `list`, `search` and `shell` start in `<dir>`, its `AGENTS.md` files load, and the code check skips callers outside it. `off` clears it; no argument shows it. Same as `rein --scope <dir>`. |
| `/add-dir` | `<path>` | Adds a working directory the agent can use without asking, for this session. Another repo's own `AGENTS.md` / `CLAUDE.md` is delivered the first time the agent works in it. |
| | *(none)* | Lists the current working directories. |
| `/permissions` | — | Lists the allow/deny rules in effect, grouped by the settings file they come from. |
| `/ide` | `reconnect` | Editor integration: shows the connected editor (VS Code, Cursor, Windsurf or JetBrains, through the Claude Code extension) and what's selected, or connects to one. → [Editor integration](../../features/ide/) |
| `/memory` | — | Shows the project's memory (`.rein/MEMORY.md`): the facts Rein has learned here. |
| `/mcp` | — | MCP servers with status and tools. Enter approves a waiting project server or reconnects one. |

### Rein itself

| Command | Arguments | What it does |
|---|---|---|
| `/settings` | — | Settings in tabs: Status line, Sidebar, Approvals, Sandbox, Shell, Subagents, Goals, Load balancing, Paste, Limits, Attribution, Worktrees, API accounts, Notifications, Updates, Privacy, Compaction, and Advanced (every key in `~/.rein/config.json`, edited in place). |
| `/settings` | `keys` · `<key> [<value> \| reset]` | Any setting in `~/.rein/config.json` from the prompt: `keys` lists them all, `<key>` explains one (meaning, choices, default), `<key> <value>` sets it (`true`/`false`, a number, a listed choice, a comma-separated list, or JSON), `<key> reset` restores the default. Applies live. See [Configuration](../configuration/). |
| `/settings` | `export [file]` · `import <file>` | Settings in tabs: Status line, Sidebar, Approvals, Sandbox, Shell, Subagents, Goals, Load balancing, Paste, Attribution, Worktrees, API accounts, Notifications, Updates, Privacy, Compaction. |
| `/tui` | `fullscreen` \| `classic` | Switches renderer and carries the conversation over. With no argument, shows which renderer is active. *Waits for idle.* |
| `/update` | — | Updates the `claude` and `codex` CLIs, checks the Codex app-server protocol, then updates Rein. *Waits for idle.* |
| `/export` | `[file]` | Saves the whole conversation as Markdown (every message, each reply's tool calls as a list) and copies it to the clipboard. Default file: `~/.rein/exports/<id>.md`; a path is relative to the project. |
| `/help` | — | Commands and skills. |
| `/exit` | — | Quits. Ctrl+C twice also exits. |

Rein has no command aliases. An unknown command prints `Unknown command /<name>. Try /help.`

## Shell commands with `!`

Start a message with `!` to run a shell command yourself, like Claude Code's bash mode: `!npm test`, `!git status`. It runs in the project with no approval (you typed it), its output shows live under the input, and the command plus its output go along with your next message so the agent knows what you ran. Ctrl+C stops it.

## Built-in skills

These entries look like commands but are **skills**. Each one sends a prepared prompt to the agent, so it queues like a message while the agent is busy. In the autocomplete list they're tagged `built-in skill`.

| Skill | Arguments | What it does |
|---|---|---|
| `/init` | `[guidance]` | Has the agent look through the project and write (or improve) `AGENTS.md`: what the project is, the real build/test/lint commands, a map, conventions and gotchas. With a `CLAUDE.md` but no `AGENTS.md`, it moves the shared rules into `AGENTS.md` and leaves `CLAUDE.md` as an `@AGENTS.md` import. |
| `/plan` | `<task>` | Plans a change before making it. Turns plan mode on, and the agent explores read-only, asks you questions, then presents a plan for approval. |
| `/plan:deep` | `<task>` | Thorough planning for big or risky changes: deeper exploration (parallel subagents), more questions and advisor reviews, then a plan for approval. Also turns on plan mode. |
| `/review` | `[what to review]` | Reviews the current changes (uncommitted plus this branch's commits; the whole project if there are none, or whatever you name) for bugs, security issues, test coverage gaps and copyright/licensing problems. One read-only reviewer per area, each on the single best model for it. The agent checks every finding against the code, drops what doesn't hold up, reports the rest, and asks which to fix. Nothing is fixed unless you pick it. → [Reviewing code](../../features/skills/#reviewing-code-review-and-reviewdeep) |
| `/review:deep` | `[what to review]` | The thorough version, in plan mode: a reviewer per area **on each provider you're signed into**, each on that provider's best model for the area. Findings are merged, checked against the code, then checked with the [advisor](../../features/subagents/) and with you. You pick which to fix (none is fine), and only those go into a `/plan:deep`-style plan for approval. |
| `/skill:create` | `<what it should do>` | Has the agent create a new Rein skill, global or for this project. |
| `/skill:edit` | `<skill and change>` | Has the agent edit an existing Rein skill. |

Your own skills from `<project>/.rein/skills/` and `~/.rein/skills/` appear in the same list. When names clash, the built-in wins, then the project skill, then the global one. A skill named like a built-in command is hidden, and Rein tells you at startup (`Skill "…" hidden by built-in command; rename to use it.`). See [Skills](../../features/skills/).

## Related

- [Keyboard & mouse](../keys/)
- [CLI flags](../cli/)
- [Your first session](../../start/first-session/)
