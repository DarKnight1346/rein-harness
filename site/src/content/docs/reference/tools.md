---
title: Tool reference
description: Parameter-level reference for every tool the model can call in Rein, with required parameters, approval behaviour, availability and limits.
---

Every model in Rein, Claude or Codex, gets the **same tool set**, run by the **same code** in the Rein process. Claude sees them as `mcp__rein__<name>` through Rein's MCP proxy. Codex receives them as dynamic tools on the thread. Either way, a call lands in `ToolHost.call` (`src/tools/host.ts`), where permission rules, hooks, approvals and checkpoints happen once for everyone.

```text title="rein"
⏺ Read(src/session/engine.ts)
⏺ Edit(src/session/engine.ts) · you approved +4 −1
⏺ Shell($ git status)
⏺ Shell($ npm test) · allowed by rule
```

The word before the parentheses is the tool's **label**, which is what you see in the transcript. This page lists tools by their **name**, which is what models and permission rules use.

## How to read this page

- **Required** parameters are marked **(required)**. Everything else is optional.
- **Approval** is one of:
  - **None.** The tool doesn't change anything and runs without asking.
  - **Mutating.** The call goes through your approval mode (`toolApproval`: ask / auto / bypass), saved rules and hooks. See [permissions](../../features/permissions/).
  - **Always asks.** Mutating, and also excluded from auto-approval and from "allow for the session". Rules and bypass still apply.
- **Main agent only** tools can't be called by subagents (the call returns an error). [`/btw`](../../features/btw/) forks get only tools that are neither mutating nor main-agent-only.

Two rules apply to *every* tool, mutating or not:

1. **Deny rules always win.** A matching `deny` rule in any settings file blocks the call before anything else runs.
2. **Paths outside the working directories ask first.** Working directories are the project, the session scratchpad, `~/.rein/skills`, `additionalDirectories`, and anything added with `/add-dir` or `--add-dir`. Reads outside can be allowed for the session. Writes outside ask in `ask` and `auto` mode (auto never approves them), and "allow for this session" adds that folder as a working directory. Bypass mode allows them. Credentials and secrets (`~/.ssh`, `~/.aws`, `.env*`, `*.pem`, …) always ask, one call at a time, even in bypass mode.

## Files

### `read`

Label `Read`. Approval: none.

Reads a file and returns lines prefixed with their 1-based line number and a tab, like `cat -n`. Reading a directory lists it. PNG, JPEG, GIF and WebP images go to the model **as images** (downscaled above 3.75 MB). PDFs return their text page by page.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Relative to the project root; absolute and `~/` paths work too. Required unless `paths` is given |
| `paths` | string[] | Several files in one call (up to 20), each shown under a `==> path <==` header. Whole text files; a file that can't be read reports its error in its place. Images and PDFs are read one at a time |
| `full` | boolean | Read a long file whole. Only matters with the [`outline-reads`](../configuration/#experiments) experiment (on by default), which otherwise shows a file over 500 lines read without `offset` / `limit` as an outline |
| `offset` | integer | First line to read (1-based) |
| `limit` | integer | Max lines, default and cap 2000 |
| `pages` | string | PDF pages, for example `"3-8"` (max 20 per read) |

Lines longer than 2000 characters are truncated. A successful read records the file's size and mtime for stale-file protection (see `edit`). Every tool call is a request that re-sends the conversation, so reading the files a change needs with `paths` in one call costs one round trip instead of one per file.

### `list`

Label `List`. Approval: none.

A directory tree: folders first, files with sizes. Hidden entries and `.git`, `node_modules`, `dist`, `build` (and other heavy folders) are skipped unless `all` is true. At most 500 entries.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | Directory, default the project root |
| `depth` | integer | Levels to descend, 1–5, default 1 |
| `all` | boolean | Include hidden entries and heavy folders |
| `workspace` | boolean | In a [workspace](../../features/workspaces/#one-tree-for-every-repo): list every repo (`path` inside each), as one tree |

### `search`

Label `Search`. Approval: none.

Regex search over file contents, returning `path:line:text`, or over file paths with `files_only`. Uses the bundled ripgrep, so it is parallel, `.gitignore`-aware and skips binaries. Falls back to a streaming JS search if ripgrep is unavailable. At most 200 result lines.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` **(required)** | string | Regular expression |
| `path` | string | Directory or file to search, default the project root |
| `glob` | string | Only files matching, for example `"*.ts"` or `"src/**/*.tsx"` |
| `files_only` | boolean | Match file paths instead of contents |
| `case_insensitive` | boolean | |
| `workspace` | boolean | In a [workspace](../../features/workspaces/#one-tree-for-every-repo): search every repo (`path` inside each), grouped by repo |

### `write`

Label `Write`. Approval: **mutating**.

Creates a file, or overwrites it entirely. Creates parent directories.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` **(required)** | string | |
| `content` **(required)** | string | Full file content |

### `edit`

Label `Edit`. Approval: **mutating**.

Replaces an exact string. `old_string` must match exactly (whitespace included, without the line-number prefixes from `read`) and be unique, unless `replace_all` is set. Files over 8 MB use a two-pass streaming replace into a temp file plus an atomic rename.

With a `.rein/architecture.yaml`, an `edit` or `write` that adds an import the [architecture rules](../../features/specs/#architecture-guardrails) forbid is refused (or, in `warn` mode, goes through with a note).

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | The file. With `edits`, the default for entries that don't name one |
| `old_string` | string | Exact text to replace |
| `new_string` | string | Replacement |
| `replace_all` | boolean | Replace every occurrence, default false |
| `edits` | array | Several replacements in one call, instead of `old_string` / `new_string`: each `{path?, old_string, new_string, replace_all?}`, in one file or several |

With `edits`, each replacement applies to the file as the ones before it left it. Every replacement is checked before anything is written, so the call changes all of its files or none; an error names the failing entry (`edits[2]: old_string not found in src/b.ts`). Every file must have been read first, as with a single edit. Approval, [permission rules](../../features/permissions/#saved-rules) (a `deny` on any file blocks the call), [checkpoints](../../features/rewind/) and the end-of-turn code check cover every file in the batch. Batches are for files up to 8 MB; larger files take a single edit. A batch that changes several files shows its preview in the approval prompt, not as an editor diff. The second single-change `edit` (or single-file `read`) in a row gets a one-line note in its result pointing at `edits` (or `paths`), once per session: models that make one call per change pay a round trip each time, and follow what results tell them more than what descriptions say.

Files changed with `write`, `edit` or `delete` are checked by Rein's [language servers](../../features/code-intelligence/) when the agent finishes its turn; problems the changes left come back as one `<code_check>` message.

**Stale-file protection** applies to `edit`, and to `write` on a file that already exists. The agent must have read the file in this conversation, and the file must not have changed since. Otherwise the call fails with "read it again". The scratchpad is exempt.

### `delete`

Label `Delete`. Approval: **mutating**.

Deletes a file or directory. Refuses to delete the project root.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` **(required)** | string | |
| `recursive` | boolean | Required for a non-empty directory |

:::note[Files: what's shared]
`write`, `edit` and `delete` (and `image_generate`) share one rule group, `edit(...)`, like Claude Code's Edit. Before any of them runs, Rein checkpoints the file so [`/rewind`](../../features/rewind/) can restore it. Writes inside the session scratchpad skip approval. Paths are resolved through symlinks before the working-directory check, and the final open uses `O_NOFOLLOW`, so a symlink swapped in after the check is refused.
:::

## Shell

### `shell`

Label `Shell`. Approval: **mutating**, except commands on the read-only list.

Runs a command in the project: `$SHELL -c` on macOS and Linux, Git Bash on Windows when installed, else PowerShell. There is no stdin or TTY. `CI=1` and `PAGER=cat` are set, ANSI codes are stripped and `\r` progress lines collapsed. Each command runs in its own process group, so killing it reaches its children.

| Parameter | Type | Notes |
| --- | --- | --- |
| `command` **(required)** | string | Command line |
| `background` | boolean | Return an id at once; read with `shell_logs`, stop with `shell_kill` |
| `timeout_ms` | integer | Foreground timeout, default 120000 (2 min), capped by `shellMaxMinutes` |
| `cwd` | string | Working directory relative to the project root |

**Foreground** calls return `[exit status]` plus the output tail: up to 2000 lines, trimmed to the last 30,000 characters. **Background** calls have no timeout. Interrupting the agent (`Esc` / `Ctrl+C`) kills its foreground command, and all agent processes die when Rein exits.

**Read-only commands run without asking.** Examples: `ls`, `cat`, `grep`, `rg`, `git status|log|diff|show`, `npm ls`, `brew info`, `<anything> --version`. Every part of a compound command (`&&`, `||`, `;`, `|`) must qualify, `>`/`>>` redirection disqualifies it, and `$( )` or backticks never qualify. A read-only command that names a path outside the working directories still asks. The full list is `readOnlyCommand` in `src/tools/plan.ts`.

### `shell_logs`

Label `ShellLogs`. Approval: none.

| Parameter | Type | Notes |
| --- | --- | --- |
| `id` | integer | Shell id. Omit to list every shell with its status |
| `lines` | integer | Tail length, default 200, max 2000 |

### `shell_kill`

Label `ShellKill`. Approval: none.

Stops a running shell and its child processes.

| Parameter | Type | Notes |
| --- | --- | --- |
| `id` **(required)** | integer | Shell id |

## Web and images

### `web_search`

Label `WebSearch`. Approval: none.

Runs one call on the [Web model](../configuration/#models) with its provider's server-side search switched on for that call only. Claude uses the CLI's `WebSearch` tool, Codex uses `web_search: "live"`. Returns a short answer plus up to 8 result links. Works for every chat model.

| Parameter | Type | Notes |
| --- | --- | --- |
| `query` **(required)** | string | At least 2 characters |
| `allowed_domains` | string[] | Passed to the search model as an instruction |
| `blocked_domains` | string[] | Passed to the search model as an instruction |

Domain filters are instructions in the prompt, not hard filters.

### `web_fetch`

Label `WebFetch`. Approval: none.

Fetches a URL locally and converts HTML to markdown. `http` is upgraded to `https`. URLs with credentials and local or private hosts (`localhost`, `*.local`, `*.internal`, `10.x`, `127.x`, `192.168.x`, `172.16–31.x`, `169.254.x`, `100.64–127.x`, `::1`, `fc/fd/fe80`) are refused. Same-host redirects are followed (up to 10). A redirect to another host is reported back instead of followed. Limits are 30 s and 10 MB per fetch, and pages are cached for 15 minutes.

| Parameter | Type | Notes |
| --- | --- | --- |
| `url` **(required)** | string | Fully-formed URL |
| `prompt` | string | With a prompt, the Web model reads up to 120,000 characters of the page and answers just that |
| `offset` | integer | Without a prompt, the markdown comes back 40,000 characters at a time. Continue from here |

### `image_generate`

Label `ImageGen`. Approval: **mutating**, but free when saving to the scratchpad. Listed only while a Codex account that can generate images is signed in.

Gives every chat model, Claude included, Codex's image generation. It runs as one ephemeral Codex thread with only image generation switched on, on the cheapest healthy Codex model. Saves PNGs and returns their paths. Takes about 15–60 s.

| Parameter | Type | Notes |
| --- | --- | --- |
| `prompt` **(required)** | string | Full description, or the edit to make |
| `path` | string | Where to save the PNG. Default: the session scratchpad (`images/`), which needs no approval |
| `reference_images` | string[] | Existing PNG/JPEG/GIF/WebP images to edit or use as references |

## Conversation history

### `sessions_search`

Label `SessionSearch`. Approval: none.

Regex search over saved conversations (messages and their tool calls), newest first. Returns `sessionId · date · #index role: snippet`, at most 60 matches.

| Parameter | Type | Notes |
| --- | --- | --- |
| `pattern` **(required)** | string | Case-insensitive by default |
| `all_projects` | boolean | Search every project, not only this one |
| `case_sensitive` | boolean | |

### `recall`

Label `Recall`. Approval: none (read-only). **Main agent only.**

| Parameter | Type | Notes |
| --- | --- | --- |
| `from` | number | First message number (1-based, as the summary's map lists them) |
| `to` | number | Last message number; up to 30 messages per call |
| `query` | string | Find where something was said in the summarized part (case-insensitive) |

After a [compaction](../../internals/context/#compaction): returns summarized messages of this conversation verbatim, tool results in full, or with `query` the places a word appears. Messages that weren't summarized are still in context, and it says so.

### `session_read`

Label `SessionRead`. Approval: none.

| Parameter | Type | Notes |
| --- | --- | --- |
| `id` **(required)** | string | Session id from `sessions_search` |
| `offset` | integer | First message |
| `limit` | integer | Messages per page, default 30 |

## Talking to you

### `ask_user`

Label `Ask`. Approval: none. **Main agent only.**

Shows one or more multiple-choice questions together. You answer every one, and each question also offers "Something else" for your own text. In a headless run the agent is told to state its assumptions and continue.

| Parameter | Type | Notes |
| --- | --- | --- |
| `questions` **(required)** | array | 1–6 questions |
| `questions[].question` **(required)** | string | |
| `questions[].options` **(required)** | array | 2–8 options: `{label` **(required)**`, description}` (plain strings work too) |
| `questions[].id` | string | Short key |
| `questions[].multi` | boolean | Allow several options |

### `todo_write`

Label `Tasks`. Approval: none. **Main agent only.**

The task list shown in the sidebar's TASKS section. Each call replaces the whole list. It is saved with the conversation.

| Parameter | Type | Notes |
| --- | --- | --- |
| `todos` **(required)** | array | |
| `todos[].content` **(required)** | string | Imperative: "Run the tests" |
| `todos[].status` **(required)** | `pending` \| `in_progress` \| `completed` | Keep exactly one `in_progress` |
| `todos[].activeForm` | string | Shown while in progress: "Running the tests" |

### `present_spec`

Label `Spec`. Approval: none. **Main agent only.** Errors unless [spec mode](../../features/specs/) is on (`/spec`).

Saves one stage of the spec to `.rein/specs/<name>/<stage>.md` and asks you to approve it (*Approve* or *Revise*). Stages go in order, each needing the one before approved. Requirements must be numbered `R1`, `R2`…; tasks must parse as a checklist, with no cycles, no dependencies on missing tasks, and no requirements that don't exist. Approving the tasks ends spec mode.

| Parameter | Type | Notes |
| --- | --- | --- |
| `stage` **(required)** | `requirements` \| `design` \| `tasks` | Which stage this is |
| `content` **(required)** | string | The stage, in markdown |

### `spec_task`

Label `SpecTask`. Approval: none. Errors until the spec's tasks are approved.

`start` records the tree before a task (refused while a task it comes after isn't done); `done` ticks its box in `tasks.md`, records the lines changed since `start` against the task's requirements (`trace.md`), and says which tasks are ready next. Subagents call it too.

| Parameter | Type | Notes |
| --- | --- | --- |
| `spec` **(required)** | string | The spec's folder name in `.rein/specs/` |
| `task` **(required)** | string | The task id, e.g. `T3` |
| `action` **(required)** | `start` \| `done` | |

### `present_plan`

Label `Plan`. Approval: none. **Main agent only.** Errors unless [plan mode](../../features/plans/) is on.

Shows the plan window, where you choose *Save & implement now*, *Save & start as a goal*, *Save only* or *Keep planning*. Saved plans go to `.rein/plans/YYYY-MM-DD-<slug>.md`.

| Parameter | Type | Notes |
| --- | --- | --- |
| `title` **(required)** | string | A few words |
| `plan` **(required)** | string | Markdown, at least 20 characters |
| `milestones` **(required)** | string[] | Ordered, checkable outcomes. The tool asks for 2–10 and rejects more than 12 |

## Goals

Both tools are always listed and return an error when no goal is active. See [goals](../../features/goals/).

### `goal_done`

Label `GoalDone`. Approval: none. **Main agent only.**

Claims the `/goal` is achieved. The decision model checks the claim against the evidence in context: the last 30 tool results since the goal started, your evidence and the last message. It accepts at p ≥ 0.7. It is rejected while plan milestones are still open.

| Parameter | Type | Notes |
| --- | --- | --- |
| `summary` **(required)** | string | What was done |
| `evidence` **(required)** | string | What was run or checked and what it showed |

### `milestone_done`

Label `Milestone`. Approval: none. **Main agent only.** Only while a goal started from a saved plan is active.

Ticks milestone *N* (`- [x]` in the plan file) after the same evidence check (p ≥ 0.7).

| Parameter | Type | Notes |
| --- | --- | --- |
| `milestone` **(required)** | number | 1-based, as listed |
| `evidence` **(required)** | string | Concrete proof |

## Subagents and helpers

### `tool`

Label: the tool it runs. Only with the `lazy-tools` [experiment](../configuration/#experiments) on (the default in `rein -p`).

| Parameter | Type | Notes |
| --- | --- | --- |
| `name` **(required)** | string | An on-demand tool from the list in this tool's description |
| `args` | object | Its arguments. Leave out to get its description and parameters |

Runs one of the tools a coding task rarely needs, which are then left out of the model's tool list. A call with `args` goes through the same approvals, rules and checkpoints as calling the tool directly.

### `diagnostics`

Label `Diagnostics`. Approval: none (read-only).

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | A file, project-relative or absolute. Omit for the whole workspace |

With an [editor connected](../../features/ide/), returns the errors and warnings the editor's language servers report (the extension's `getDiagnostics`), headed `[from the editor]`. Otherwise it asks the language servers Rein runs itself ([code intelligence](../../features/code-intelligence/)), headed `[from Rein's language servers]`; without a `path` that covers the files opened so far. If the file's server isn't installed, the result tells the agent to offer `lsp_install`.

### `affected`

Label `Affected`. Approval: none (read-only). Only listed with the `affected-tool` [experiment](../configuration/#experiments) on, in an Nx, Turborepo, Bazel or Pants workspace.

| Parameter | Type | Notes |
| --- | --- | --- |
| `files` | string[] | Changed files, project-relative. Omit for the working tree's changes vs `HEAD` (and untracked files) |

Asks the build system which projects or targets the change affects, and returns them with the command that tests just those. See [What a change affects](../../features/build-and-test/#what-a-change-affects).

### `repo_map`

Label `RepoMap`. Approval: none (read-only). Only listed with the `repo-map` [experiment](../configuration/#experiments) on.

| Parameter | Type | Notes |
| --- | --- | --- |
| `path` | string | A folder to map, project-relative. Omit for the whole project |
| `budget_tokens` | integer | Size of the map, 500–20,000 (default 4,000) |

Each source file's top-level declarations, ranked by how much the file exports. See [A map of the repo](../../features/large-codebases/#a-map-of-the-repo).

### `org_search`

Label `OrgSearch`. Approval: none (read-only). Only listed once `codeSearch` is [configured](../configuration/).

| Parameter | Type | Notes |
| --- | --- | --- |
| `query` **(required)** | string | In the server's own syntax (Sourcegraph or Zoekt) |
| `max` | integer | Most results, 1–100 (default 30) |

Searches every repo your Sourcegraph or Zoekt server indexes, and returns `repo  file:line: text` per match. See [Search the whole org](../../features/large-codebases/#search-the-whole-org).

### `semantic_search`

Label `SemanticSearch`. Approval: none (read-only). Only listed once `semanticIndex` is [configured](../configuration/) and `/index` has built this project's index.

| Parameter | Type | Notes |
| --- | --- | --- |
| `query` **(required)** | string | What you're looking for, in words |
| `k` | integer | How many chunks, 1–30 (default 8) |

The chunks (about 60 lines each) closest in meaning to the query, with `file:start-end`, a similarity score and their first lines. See [Search by meaning](../../features/large-codebases/#search-by-meaning).

### `lsp_install`

Label `InstallLanguageServer`. Approval: **always asks, even in bypass mode.**

| Parameter | Type | Notes |
| --- | --- | --- |
| `server` **(required)** | string | The server id from the diagnostics result or edit note that suggested it: `cpp`, `asm`, `rust`, `go`, `java`, `kotlin`, `python`, `typescript`… An unknown id returns the full list |

Installs the latest version of that language server into Rein's `lsp/<server>/` folder (npm, release binaries, the vendor's download, or the language's own installer: `go`, `gem`, `dotnet`, pip, Coursier, ghcup, opam, R, Julia, Nix) and records the version. Servers that need a runtime that isn't installed (Java, Erlang, R…) say so instead of installing. See [code intelligence](../../features/code-intelligence/#installing-a-server).

### `agent`

Label `Agent`. Approval: none. Spawning has no side effects, but the subagent's own tool calls do go through approval. **Main agent only.**

| Parameter | Type | Notes |
| --- | --- | --- |
| `task` **(required)** | string | Complete, self-contained instructions |
| `mode` **(required)** | `new` \| `fork` | `fork` branches your live session: full history, same model and account. `new` starts a fresh session |
| `model` | string | `"auto"` or a ref from the live list in the tool description. For `new` mode only. **Absent** when you pinned a subagent model with "Your model first" priority |
| `name` | string | Short name shown in the sidebar |
| `background` | boolean | Return an id at once; collect with `agent_result` |
| `agent_type` | string | Run as a [named definition](../../features/subagents/#named-subagent-definitions) from `.rein/agents` or `.claude/agents` (role, tools, model). Always a new session. **Present only when definitions exist** |

The description lists the models signed in right now, with cost hints, and the concurrency limit (`subagentLimit`). When a subagent ends its turn, the decision model checks it actually finished (p ≥ 0.5). If not, it is told to continue, up to 3 extra rounds. Subagents can't spawn subagents.

### `agent_result`

Label `AgentResult`. Approval: none. **Main agent only.**

| Parameter | Type | Notes |
| --- | --- | --- |
| `id` | integer | Subagent id. Omit to list all |
| `wait` | boolean | Block until it finishes |

Background reports the agent never collects are delivered to it as a message when they finish.

### `explore`

Label `Explore`. Approval: none. **Main agent only.** Listed only with the [`cheap-explore`](../configuration/#experiments) experiment on and a Claude account signed in.

| Parameter | Type | Notes |
| --- | --- | --- |
| `question` **(required)** | string | What to find out in the codebase, with any names or paths that help |

Runs a subagent on the cheapest signed-in Claude model (Haiku) with only `read`, `list` and `search`, and returns its findings: file paths, line numbers, names and short snippets. The files it reads stay out of the main model's context.

### `advisor`

Label `Advisor`. Approval: none. Listed only when `/model` → Advisor is set.

One call to the stronger advisor model. It sees the conversation (summary plus recent messages with tool calls, ≤ 40k tokens), or for a subagent its task and work so far, plus the question. It cannot run tools.

| Parameter | Type | Notes |
| --- | --- | --- |
| `question` **(required)** | string | Be specific |
| `context` | string | Extra details: code, errors, options considered |

### `decide`

Label `Decide`. Approval: none.

Hands small judgments to the cheap [decision model](../../internals/decision-model/) instead of the agent reasoning them out: triage, classification, picking options, yes/no checks. The decision model sees only `context`, nothing else.

| Parameter | Type | Notes |
| --- | --- | --- |
| `context` **(required)** | string | Everything the judgment needs (first 60,000 characters used) |
| `questions` **(required)** | array | 1–25 questions |
| `questions[].type` **(required)** | `yes_no` \| `choice` \| `score` | |
| `questions[].question` **(required)** | string | |
| `questions[].id` | string | Answer key, default `q1`, `q2`, … |
| `questions[].options` | object \| string[] | `choice`: `{"name": "meaning"}` or a list, at least 2 |
| `questions[].scale` | string[] | `score`: level descriptions, lowest first, at least 2 |
| `questions[].yes` / `.no` | string | `yes_no`: what counts as yes / no |

Answers come back as `id: yes (p(yes) = 0.83)`, `id: <option> (confidence 0.91)` or `id: 2.40 on 0–4 ≈ "<level>"`, followed by `(via <backend>)`.

### `skill`

Label `Skill`. Approval: none. Listed only when at least one skill is installed.

Loads a skill's instructions (and tells the agent its folder). The description lists every built-in, project and global skill. Loading a `planMode` skill such as `plan` turns plan mode on.

| Parameter | Type | Notes |
| --- | --- | --- |
| `name` **(required)** | string | Skill name or alias |
| `args` | string | The request or details |

### `remember`

Label `Remember`. Approval: none, even though it writes `.rein/MEMORY.md`.

Saves one lasting fact to project memory, loaded into every future session in the project. Duplicates are ignored. Memory is capped at 32 KB.

| Parameter | Type | Notes |
| --- | --- | --- |
| `fact` **(required)** | string | One or two sentences |
| `scope` | `project` \| `workspace` | `workspace` saves it to the [workspace's](../../features/workspaces/#workspace-memory) memory instead, shared by all its repos. Only in a workspace; default `project` |

### `forget`

Label `Forget`. Approval: none.

Removes every memory fact containing `match` (case-insensitive).

| Parameter | Type | Notes |
| --- | --- | --- |
| `match` **(required)** | string | At least 3 characters |

## MCP

See [MCP](../../features/mcp/) for configuration files and the `/mcp` screen.


In a workspace it removes matching facts from the workspace's memory too.
### `mcp_list`

Label `McpList`. Approval: none. No parameters. Lists servers with status, transport, source file and tools.

### `mcp_add`

Label `McpAdd`. Approval: **always asks**. The prompt shows the exact command or URL.

| Parameter | Type | Notes |
| --- | --- | --- |
| `name` **(required)** | string | 1–40 letters, digits, `-`, `_` |
| `command` | string | stdio: program to run |
| `args` | string[] | stdio: arguments |
| `env` | object | stdio: extra environment. Use `${VAR}` for secrets |
| `url` | string | Remote server URL (give `command` *or* `url`) |
| `transport` | `http` \| `sse` | Remote transport, default `http` |
| `headers` | object | Remote HTTP headers |
| `scope` | `project` \| `user` | `project` (default) saves to `.mcp.json`; `user` saves to `~/.rein/mcp.json` |

### `mcp_remove`

Label `McpRemove`. Approval: **mutating**.

| Parameter | Type | Notes |
| --- | --- | --- |
| `name` **(required)** | string | Server name. Servers added with `claude mcp add` must be removed with `claude mcp remove` |

### `mcp_call`

Label `McpCall`. Approval: none for the call itself. The target tool's own approval and rules apply.

Calls a connected server's tool in the same turn, before its tools appear directly (they do from the next message).

| Parameter | Type | Notes |
| --- | --- | --- |
| `server` **(required)** | string | |
| `tool` **(required)** | string | |
| `args` | object | The tool's arguments |

### Server tools: `mcp__<server>__<tool>`

Every connected server's tools appear as `mcp__<server>__<tool>` (names over 50 characters are shortened with a hash suffix). They are **mutating unless the server marks them `readOnlyHint`**. Results are capped at 60,000 characters. Rules can target a whole server (`mcp__github`) or one tool (`mcp__github__create_issue`).

## Limits at a glance

| Limit | Value | Where |
| --- | --- | --- |
| Any tool result sent to the model | 60,000 characters | `MAX_RESULT_CHARS`, `src/tools/host.ts` |
| Tool result kept in the transcript | 4,000 characters | `src/session/engine.ts` |
| `read` | 2000 lines, 2000 characters per line, 20 PDF pages | `src/tools/fs.ts`, `src/tools/media.ts` |
| `list` | depth 1–5, 500 entries | `src/tools/fs.ts` |
| `search` | 200 lines | `src/tools/fs.ts` |
| `shell` foreground | 2 min default, `shellMaxMinutes` cap; 2000 lines / 30,000 characters back | `src/tools/registry.ts` |
| `web_fetch` | 30 s, 10 MB, 10 redirects, 15-min cache; 40k page / 120k with prompt | `src/tools/web.ts` |
| `decide` | 25 questions, 60,000 characters of context | `src/decider/tool.ts` |
| `ask_user` | 6 questions, 2–8 options | `src/tools/ask.ts` |
| Project memory | 32 KB | `src/tools/memory.ts` |
| MCP tool results | 60,000 characters | `src/mcp/manager.ts` |

## Related

- [Tools overview](../../features/tools/): what the agent can do, in plain terms
- [Permissions](../../features/permissions/): rules, approval modes, plan mode
- [Architecture](../../internals/architecture/): how one tool host serves both CLIs
- [Configuration](../configuration/): `toolApproval`, `shellMaxMinutes`, `additionalDirectories`
