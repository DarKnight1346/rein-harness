---
title: Files & environment
description: What Rein stores in ~/.rein and in each project's .rein folder, which settings and instruction files it reads, every environment variable, and what is safe to delete.
---

Rein keeps all of its own state in one folder, `~/.rein`, plus a small `.rein/` folder inside each project for things you may want to commit (plans, rules, project memory, skills). It never copies your `claude` or `codex` credentials. Imported logins stay exactly where the CLIs put them.

```sh
ls ~/.rein
# accounts/  accounts.json  checkpoints/  config.json  scratch/  sessions/  state/
```

## `~/.rein` (`REIN_HOME`)

Set `REIN_HOME` to move the whole folder, for example to keep a test setup apart from your real one. Secrets (API keys, the Jev key) then live in that folder's `secrets/` instead of the macOS Keychain; set `REIN_KEYCHAIN=1` as well to keep using the Keychain, so the separate setup shares the keys of your normal one.

:::note[Linux: XDG base directories]
On Linux (or anywhere the `XDG_*` variables are set), a new install follows the [XDG Base Directory spec](https://specifications.freedesktop.org/basedir-spec/latest/) instead of one `~/.rein` folder:

| What | Where |
|---|---|
| What you write: `config.json`, `settings.json`, `mcp.json`, `AGENTS.md`, `system-prompt.md`, `skills/`, `agents/` | `$XDG_CONFIG_HOME/rein` (default `~/.config/rein`) |
| What Rein keeps: conversations, accounts, checkpoints, exports, secrets, MCP sign-ins, language servers | `$XDG_DATA_HOME/rein` (default `~/.local/share/rein`) |
| Bookkeeping: usage, input history, trusted projects, the update lock (`state/` below) | `$XDG_STATE_HOME/rein` (default `~/.local/state/rein`) |

An existing `~/.rein` keeps being used as it is, and so does `REIN_HOME`. To switch an existing install to the XDG layout, move its files into those folders and remove `~/.rein`. The paths below are relative to whichever folder holds them.
::: Files Rein writes here are created `0600` in `0700` directories, written atomically (temp file + rename).

| Path | What it is |
| --- | --- |
| `config.json` | Your settings. See [Configuration](../configuration/) |
| `accounts.json` | Account registry: `{id, provider, home, imported, email, plan}` per account, plus `importOffered` (the first-run import prompt is shown once). `home: null` means "the CLI's default folder, env var unset". |
| `accounts/claude/<id>/` | `CLAUDE_CONFIG_DIR` for a Claude account you added with `/login` (`claude-1`, `claude-2`, …) |
| `accounts/codex/<id>/` | `CODEX_HOME` for a Codex account you added (`codex-1`, …) |
| `state/trackers.json` | Issues the [trackers](../../features/trackers/) have taken (so a restart doesn't redo them), with their status and branch |
| `worktrees/<project>/rein-<issue>/` | The worktree an issue was worked on, on its `rein/<issue>` branch, kept for you to review. Remove it with `git worktree remove` when you're done |
| `state/build-times/` | Per project, the last 10 durations of each build or test command (for `buildTimeWarnings`) |
| `state/flaky/` | With `flaky-quarantine`: per project, recent test outcomes by code fingerprint and the tests found flaky. `/flaky clear` empties a project's file |
| `state/mcp-pins.json` | With `mcpPinning`: each MCP server's launch config and tool list as first approved (hashes and tool names). Delete it to start over |
| `state/usage.json` | Last-known usage windows per account, plus limit cooldowns (account unusable until a time) |
| `exports/<id>.md` | Conversations saved with `/export` (when no file is given) |
| `mcp-auth/<host>_<path>.json` | OAuth tokens and client registration for each remote MCP server you signed in to (owner-only), e.g. `mcp.linear.app_mcp.json`. Delete one to sign out of that server |
| `state/codex-compat.json` | Result of the compatibility check for the installed `codex` version (and its feature flags). Delete it to re-check |
| `state/trusted-projects.json` | Projects whose hooks you trusted, with a hash of the hooks as reviewed (a change asks again) |
| `state/input-history.json` | Messages you sent, per project (the last 200), for `↑` recall in the input |
| `state/context-windows.json` | Context windows learned from real responses (`result.modelUsage` on Claude), remembered across restarts |
| `state/claude-models-<id>.json` | Model list the `claude` CLI reported for that account. Refreshed in the background once a day |
| `state/codex-catalog/<id>.json` | Rein's rewritten Codex model catalog with the built-in tools stripped. See [drivers](../../internals/drivers/) |
| `sessions/<id>.jsonl` | Conversation transcripts, append-only: one line per message, plus meta lines (summary, native session refs, tokens, subagents, goal) and `progress` lines that record a running turn's tool calls, so a crash mid-turn loses nothing |
| `sessions/<id>.meta.json` | Small index entry per conversation, used for listing and `/resume` |
| `scratch/<id>/` | The session's scratchpad. The agent can write here without approval. Pasted and dropped images are copied to `scratch/<id>/images/` |
| `checkpoints/<id>/` | [`/rewind`](../../features/rewind/) data: `tree.git` (a private git store of whole-project snapshots, never your project's `.git`), `trees.json`, and per-file checkpoints (`index.jsonl` + content-addressed `blobs/`, ≤ 10 MB per file); in a workspace, `repos/<repo>-<hash>/` holds the same snapshot store for each other repo |
| `checkpoints/spec-trace/` | The tree recorded when a spec task starts, so `spec_task done` can trace the lines it changed (a private store like `/rewind`'s) |
| `index/<hash>.json` | [Semantic indexes](../../features/large-codebases/#search-by-meaning), one per project: each file's change key and its chunks' vectors. `/index` rebuilds it |
| `schedule/` | [Scheduled jobs](../../features/headless/#scheduled-jobs): `state.json` (last run and result per job), `projects.json` (the projects `rein schedule run --due` covers), `logs/` (each run's output) |
| `hosts/` | [Background sessions](../../features/sessions/): one `<id>.json` per running host (its pid, folder and socket) |
| `live/` | The [session dashboard](../../features/sessions/#every-session-at-a-glance): `<pid>.json` per running Rein (state, folder, title, goal) and `<pid>.inbox`, the messages sent to it. Removed when it exits |
| `skills/` | Global skills, one folder each with a `SKILL.md` |
| `mcp.json` | User-scope MCP servers (`mcp_add` with `scope: "user"`) |
| `settings.json` | Global permission rules and hooks (Claude Code format) |
| `AGENTS.md` | Global instructions added to every session's system prompt |
| `system-prompt.md` | Optional. Replaces Rein's **base** system prompt only. Tools, project info, memory and instruction files are still appended |
| `secrets/vault.json` | The [secrets vault](../../features/vault/) (`0600`), used only when the Keychain / DPAPI isn't available (Linux, or `REIN_HOME` set). On macOS it's the Keychain item `rein-vault`; on Windows the DPAPI-encrypted `secrets/vault.json.dpapi` |
| `secrets/jev.key` | Jev API key fallback file (`0600`), used only when the Keychain / DPAPI isn't available. On Windows the DPAPI-encrypted key is `secrets/jev.key.dpapi` |
| `voice/ggml-<model>.bin` | The speech model for [voice input](../../features/voice/), downloaded once by `/voice setup` (about 60 MB) |
| `lsp/<server>/` | Language servers `lsp_install` installed (`lsp/cpp/`, `lsp/typescript/`, …; HTML, CSS and JSON share `lsp/vscode-langservers/`), each with `installed.json` recording the version. See [code intelligence](../../features/code-intelligence/) |
| `update.lock` | Held for up to 10 minutes while a background auto-update installs, so several Rein windows don't install at once |

Session ids look like `2026-10-03-14-22-05-1a2b3c4d`. Sessions are listed per project by the folder they ran in.

:::note[Where the Jev key lives]
On macOS the Jev key goes into the Keychain as `rein-jev-api-key`, not into `~/.rein`. On Windows it is a DPAPI-encrypted file that only your Windows user can decrypt. `TYPESAFE_API_KEY` in the environment overrides both. With `REIN_HOME` set, Rein skips the Keychain and DPAPI and uses `secrets/jev.key`, so test setups never touch your real key.
:::

### Imported logins

When Rein imports your existing `claude` and `codex` logins on first run, it registers them **in place** (`claude-default`, `codex-default`, with `home: null`). Rein runs those CLIs with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` unset, because pointing `CLAUDE_CONFIG_DIR` at `~/.claude` explicitly reads as logged out. Removing an imported account in `/login` only unregisters it. Rein never logs it out or deletes its folder.

## Per-project `.rein/`

| Path | What it is | Commit it? |
| --- | --- | --- |
| `.rein/settings.json` | Project permission rules and hooks. "Always allow" in an approval prompt saves rules here | Yes, if the team shares rules |
| `.rein/settings.local.json` | Personal project rules, plus `enabledMcpjsonServers` (the project `.mcp.json` servers you approved) | No |
| `.rein/MEMORY.md` | [Project memory](../../features/memory/): facts the agent saved with `remember`, loaded into every session here. Edit it freely | Usually |
| `.rein/MEMORY.md` in a workspace folder | [Workspace memory](../../features/workspaces/#workspace-memory): facts shared by every repo of the workspace (`remember` with `scope: "workspace"`) | Usually |
| `.rein/plans/` | Saved plans, `YYYY-MM-DD-<slug>.md`, with `## Milestones` checkboxes | Yes |
| `.rein/bench/` | [`rein bench`](../../features/insight/#benchmark-on-your-own-repo): `tasks.json` (tasks from the repo's commits) and `results/` (each run's results) | Optional |
| `.rein/schedule.yaml` | [Scheduled jobs](../../features/headless/#scheduled-jobs): a cron time and a prompt each | Yes |
| `.rein/architecture.yaml` | [Architecture rules](../../features/specs/#architecture-guardrails): layers, and which may import which. Checked on every edit | Yes |
| `.rein/specs/<name>/` | [Specs](../../features/specs/): `requirements.md`, `design.md`, `tasks.md` (an approved stage starts with `<!-- approved YYYY-MM-DD -->`), and `trace.json` / `trace.md` linking requirements to code | Yes |
| `.rein/skills/` | Project skills | Yes |
| `.mcp.json` *(project root)* | Project MCP servers (`mcp_add` default scope). Each one needs your one-time approval before it runs | Yes |

## Files Rein reads

### Settings (permission rules, hooks and budgets)

All six files are merged, global first. Deny rules win wherever they appear. Hooks come from the same files and are re-read live.

1. `~/.claude/settings.json`
2. `~/.rein/settings.json`
3. `<project>/.claude/settings.json`
4. `<project>/.claude/settings.local.json`
5. `<project>/.rein/settings.json`
6. `<project>/.rein/settings.local.json`

A project's `.rein/settings.json` (or `settings.local.json`) can also set a `budget` with lower spending caps than yours; see [Cost & budgets](../../features/cost/#budgets).

Existing Claude Code rules and hooks keep working: `Bash(npm test:*)`, `Edit(src/**)` and matchers like `Bash` all map onto Rein's tools. See [permissions](../../features/permissions/) and [hooks](../../features/hooks/).

### MCP servers

Earlier sources win on a name clash: `<project>/.mcp.json`, then `~/.rein/mcp.json`, then `~/.claude.json` (servers added with `claude mcp add`). `${VAR}` and `${VAR:-default}` are expanded from your environment. See [MCP](../../features/mcp/).

### Context packs

`<project>/.rein/packs.yaml`: named file bundles that `/pack <name>` attaches. See [Context packs](../../features/large-codebases/#context-packs).

### Policy

`<project>/.rein/policy.yaml` and `~/.rein/policy.yaml`: deny and ask rules over tools, paths and commands, and which models may work here. Both apply. See [Policy as code](../../features/safety/#policy-as-code-reinpolicyyaml).

### Workspace manifest

`rein.workspace.yaml` (or `.yml`), the nearest one at or above the launch folder: the repos of a [workspace](../../features/workspaces/). They become working directories and are listed in the system prompt.

### Instruction files

Added to the system prompt for every provider, up to 64 KB each, duplicates removed:

1. `~/.rein/AGENTS.md`
2. `~/.claude/CLAUDE.md`
3. In a [workspace](../../features/workspaces/), the same files next to `rein.workspace.yaml` (when that folder is above the git root)
4. From the git root down to the current folder: `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` in each folder

`AGENTS.md` / `CLAUDE.md` files in subfolders are delivered with the first tool result that touches that folder, once per conversation (again after a compaction). Codex's own project-doc loading is switched off (`project_doc_max_bytes=0`) so nothing is injected twice.

## Environment variables

### For users

| Variable | Effect |
| --- | --- |
| `REIN_HOME` | Root of Rein's state instead of `~/.rein`. Also disables Keychain/DPAPI for the Jev key |
| `REIN_KEYCHAIN` | `1` (macOS): keep using the Keychain for secrets even with `REIN_HOME` set |
| `REIN_CLAUDE_BIN` | Path to the `claude` binary (default: `claude` on `PATH`) |
| `REIN_CODEX_BIN` | Path to the `codex` binary (default: `codex` on `PATH`) |
| `SRC_ACCESS_TOKEN` | Sourcegraph access token for [`org_search`](../../features/large-codebases/#search-the-whole-org) (`codeSearch` in config) |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY` | Route Rein's own requests through a proxy (never local connections). See [Install → Behind a corporate proxy](../../start/install/#behind-a-corporate-proxy) |
| `NODE_EXTRA_CA_CERTS` | A PEM file of extra CA certificates, for a TLS-inspecting proxy (read by Node at startup) |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` | Where a new install keeps its config, data and state on Linux (see above) |
| `REIN_NO_AUTOUPDATE` | Any value turns off the launch-time auto-update |
| `REIN_NO_BROWSER` | Don't open a browser for login URLs; Rein still shows the URL |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The OTLP endpoint when `otel` is set in config without an `endpoint` (see [Observability](../../features/observability/)) |
| `REIN_ENV_KEYS` | `1` (for CI, as the [GitHub Action](../../features/headless/#the-rein-github-action) sets it): a one-run Claude account that uses `ANTHROPIC_API_KEY` from the environment through the official `claude` CLI, in a fresh config folder; never saved. Otherwise Rein removes that variable so each account uses its own login |
| `REIN_NO_USAGE_REFRESH` | Turn off background usage refresh (the occasional tiny Claude ping and Codex usage reads) |
| `REIN_GIT_BASH_PATH`, `CLAUDE_CODE_GIT_BASH_PATH` | Windows: which `bash.exe` the shell tool and hooks use. Otherwise Rein looks in the standard Git for Windows locations, then next to `git` on `PATH`, then falls back to PowerShell |
| `TYPESAFE_API_KEY` | Jev API key, which overrides the stored one |
| `TYPESAFE_BASE_URL` | Jev API base URL (default `https://api.typesafe.ai`) |

### Set by Rein for child processes

| Variable | Where |
| --- | --- |
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | Set to the account's folder for accounts you added. **Removed** for imported accounts |
| `REIN_TOOL_SOCKET` | Given to the MCP proxy that `claude` launches: the unix socket (named pipe on Windows) back to Rein's tool host |
| `MCP_TOOL_TIMEOUT` | 24 h for Claude sessions with tools, so Rein's own shell cap is what applies |
| `MAX_THINKING_TOKENS=0` | Fast Claude one-shots (decisions, carry selection, page reading) |
| `CI=1`, `PAGER=cat`, `GIT_PAGER=cat`, `FORCE_COLOR=0` | The agent's shell commands |
| `REIN_SESSION`, `REIN_MODEL`, `REIN_GOAL` | The agent's shell commands, with `provenance` on: the conversation id, the model working now, the active goal (see [Provenance](../../features/pull-requests/#provenance-on-agent-commits)) |
| `REIN_PROJECT_DIR`, `CLAUDE_PROJECT_DIR` | Hook commands |

### Removed before launching a CLI

So the account's own subscription login is always what's used, Rein strips these from the environment of every `claude` / `codex` process (`src/providers/env.ts`):

- Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
- Codex: `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_HOME`

:::caution
This applies to the CLIs Rein launches, not to commands the agent runs. The `shell` tool inherits your full environment, API keys included. See [security](../../project/security/).
:::

A few more variables (`CODEX_HOME_DEFAULT`, `REIN_CLAUDE_SETTINGS`, `REIN_CLAUDE_JSON`, `REIN_CLAUDE_GLOBAL`, `REIN_CLIPBOARD_FILE`, `REIN_CLIPBOARD_IMAGE`, `REIN_INSTALL_ROOT`) exist only so the test suite never touches your real files. Don't set them.

## What's safe to delete

Quit Rein first.

| Delete | Safe? | What you lose |
| --- | --- | --- |
| `state/` | Yes | Usage snapshots and cooldowns (refetched on use), learned context windows, cached model lists, the Codex catalog (all regenerated) |
| `scratch/` | Mostly | Agent scratch files, and the attached images that resumed conversations point to |
| `checkpoints/` | Yes | `/rewind` for past conversations |
| `voice/` | Yes | The speech model (`/voice setup` downloads it again) |
| `lsp/` | Yes | Installed language servers (the agent offers to install them again) |
| `index/` | Yes | Semantic indexes (`/index` builds them again) |
| `sessions/` | Yes | Conversation history: `/resume`, `rein --continue`, `sessions_search` |
| `config.json` | Yes | Your settings (defaults return) |
| `accounts/<provider>/<id>/` | **No.** Use `/login` → remove | The login of an account you added. Deleting it by hand leaves `accounts.json` pointing at a missing folder |
| `accounts.json` | Careful | The account registry. Rein offers to import your default logins again; folders under `accounts/` become orphans |

### Resetting Rein completely

```sh
rm -rf ~/.rein
```

This wipes conversations, settings and the CLI logins of accounts you **added** in Rein. Your own `~/.claude` and `~/.codex` logins are untouched. On macOS, also remove the Jev key from the Keychain if you stored one:

```sh
security delete-generic-password -s rein-jev-api-key -a rein
```

Project folders keep their `.rein/` (rules, memory, plans, skills). Delete those per project if you want them gone.

## Related

- [Configuration](../configuration/): every `config.json` key
- [Accounts](../../features/accounts/): adding, importing and removing accounts
- [Security](../../project/security/): what Rein can and can't touch
- [FAQ](../../project/faq/): troubleshooting
