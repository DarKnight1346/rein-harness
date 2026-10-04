---
title: Drivers
description: How Rein drives the official claude CLI over stream-json and codex over the app-server JSON-RPC protocol, with their built-in tools stripped, Rein's tools injected, and no OAuth token ever touched.
---

Rein never calls a model API with your subscription credentials. Every request goes through the official `claude` and `codex` binaries, each signed in to its own account. The drivers in `src/providers/claude/` and `src/providers/codex/` turn those CLIs into clean, tool-less chat engines that Rein can steer: switch model mid-conversation, interrupt, fork, resume, and call Rein's own tools.

## Account isolation and env hygiene

Each account is a separate CLI home directory:

| Provider | Variable | Rein-added account | Imported default login |
| --- | --- | --- | --- |
| Claude | `CLAUDE_CONFIG_DIR` | `~/.rein/accounts/claude/claude-1/` | variable left **unset** |
| Codex | `CODEX_HOME` | `~/.rein/accounts/codex/codex-1/` | variable left **unset** |

The imported default logins run with the variable unset, not pointed at `~/.claude`. Setting `CLAUDE_CONFIG_DIR=~/.claude` explicitly makes Claude look logged out, because it switches to a different config path and keychain key. That was found in the first spike and is why `Account.home` is `null` for imported accounts.

`accountEnv()` in `src/providers/env.ts` builds every child environment. It first **strips** anything in your shell that would override the account's own subscription login:

- Claude: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`
- Codex: `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_HOME`

Then it sets the home variable only for Rein-owned accounts. With a stray API key in your environment, the CLI still bills the subscription you picked, and one account can never leak into another.

:::note[No tokens, ever]
Rein doesn't read, copy or store OAuth tokens. Logins happen inside the CLIs (`claude auth login --claudeai`, Codex's `account/login/start`), credentials stay wherever the CLI keeps them, and login status comes from the CLIs themselves (`claude auth status --json`, Codex `account/read`). The only secret Rein stores is an optional Jev API key. See [Security](../../project/security/).
:::

## Claude: one stream-json process per conversation

`ClaudeSession` (`src/providers/claude/session.ts`) runs one long-lived process per native conversation. The flags come from `claudeArgs()`:

```sh
claude -p \
  --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --system-prompt "<Rein's system prompt>" \
  --tools "" \
  --strict-mcp-config --mcp-config '{"mcpServers":{"rein":{"command":"node","args":[".../dist/tools/mcpProxy.js"],"env":{"REIN_TOOL_SOCKET":"/tmp/rein-….sock"}}}}' \
  --allowedTools mcp__rein__read,mcp__rein__edit,… \
  --setting-sources "" \
  --disable-slash-commands \
  --model sonnet [--effort high] [--resume <session-id> [--fork-session]] [--no-session-persistence]
```

What each piece buys:

| Flag | Why |
| --- | --- |
| `--tools ""` | Turns off every built-in tool (Bash, Edit, WebFetch…). Rein's tools replace them. |
| `--strict-mcp-config --mcp-config …` | Exactly one MCP server, `rein`. Without `--strict-mcp-config`, your claude.ai connectors (Docs, Gmail…) get injected. |
| `--allowedTools mcp__rein__…` | Pre-approves Rein's tools inside the CLI, since Rein does its own approvals. |
| `--setting-sources ""` | Ignores your Claude Code settings, hooks and permissions. Rein reads those files itself and applies them its own way. |
| `--disable-slash-commands` | Your Claude Code skills and commands don't leak into the session. |
| `--system-prompt` | Rein's own prompt (tools, project, scratchpad, memory, AGENTS.md / CLAUDE.md). |
| `--no-session-persistence` | Only on one-shots and forks, so decider calls don't pile up in your Claude history. |

Rein never passes `--bare`, which refuses subscription OAuth.

### Talking to the live process

Turns are written to stdin as `{"type":"user","message":{...}}`, with images as base64 content blocks ahead of the text. Rein uses **control requests** on the same stream:

```json
{"type":"control_request","request_id":"rein-1","request":{"subtype":"set_model","model":"opus"}}
{"type":"control_request","request_id":"rein-2","request":{"subtype":"interrupt"}}
```

- `set_model` switches the model **inside the running process**. No restart, no `--resume`, prompt cache intact. That's why a model switch within the same account is free.
- `interrupt` ends the turn with `result/error_during_execution`, which Rein reports as an interruption rather than an error. The process keeps serving later turns.
- `initialize` (in a separate throwaway process) returns the account's model list: names, descriptions, supported effort levels and the default. It's cached per account in `~/.rein/state/claude-models-<id>.json` and refreshed in the background once a day. Nothing is hardcoded.

Control requests time out after 15 seconds.

**Effort is fixed per process** (`--effort`). When the effort changes, `Engine.prepare()` closes the process and the next one opens with `--resume <id>`. The history carries over, though the prompt cache doesn't, which is why auto effort only changes level when the cache is cold anyway.

### Reading the stream

`onLine()` handles the events Rein cares about:

- `system/init`: captures `session_id` for resume.
- `stream_event`: `text_delta`s become reply text (thinking deltas are dropped). `message_start` / `message_delta` usage gives live token counts per API call. A tool-using turn makes several calls, so they're summed.
- `rate_limit_event`: `unifiedWindows.five_hour` / `seven_day` with `utilization` (0–1) and `resetsAt` (unix seconds). Parsed into usage windows by `parseRateLimitEvent()` in `src/providers/claude/stream.ts`. Several weekly sub-limits collapse to the tightest one. A status other than `allowed` marks the account limited.
- `result`: success, or an error classified by `classifyError()` as `limit`, `overloaded`, `context`, `auth` or `other`. The context figure is the **last** API call's input, not `result.usage`, which sums every call in the turn and would overstate it. `result.modelUsage[*].contextWindow` teaches Rein each model's real window, remembered in `~/.rein/state/context-windows.json`.

The `rate_limit_event` only fires on a process's first request, so a long chat's usage goes stale. A refresh spawns a fresh one-shot on the account's cheapest model that replies `ok`. That ping is the only way to read Claude usage, which is why Rein rations it. See [Load balancing](../load-balancing/).

### Rein's tools over MCP

`DISABLE_AUTO_COMPACT=1` is set for chat sessions: Rein compacts the conversation itself, mid-turn included (see [Context carry & compaction](../context/)). `MCP_TOOL_TIMEOUT` is set to 24 hours whenever tools are attached. A shell command can legitimately run for hours, plus however long the approval prompt waits, and Rein enforces the real limit (`shellMaxMinutes`) itself.

The MCP proxy (`src/tools/mcpProxy.ts`) is under 70 lines and has no dependencies. It answers `initialize` and `ping`, and forwards `tools/list` and `tools/call` over the socket. Results come back as MCP content (`text`, plus `image` blocks for images the `read` tool returns) with `isError` set from the tool's `ok`.

### One-shots and forks

- **One-shot** (`claudeOneShot`): decider, compactor, carry selection, web, advisor, usage ping. A throwaway non-persisted process. `fast: true` adds `MAX_THINKING_TOKENS=0`, which cut a Haiku decision from about 4 s to about 1 s in testing. Web search one-shots use `--tools WebSearch --allowedTools WebSearch`, the CLI's server-side search and nothing else.
- **Fork** (`/btw`, fork-mode subagents): `--resume <id> --fork-session --no-session-persistence`. A new branch with the full history, tool results included, while the original keeps running.

## Codex: one app-server per account

Codex is driven through `codex app-server`, a JSON-RPC protocol over stdio (`src/providers/codex/appServer.ts`). Unlike Claude, it's **one process per account**, shared by every conversation on that account, pooled in `AppServerPool` (`src/providers/codex/adapter.ts`).

### Startup and the catalog trick

Codex's built-in tools don't come from feature flags. They come from the **model catalog**: a model with `tool_mode: "code_mode_only"`, `apply_patch_tool_type: "freeform"` and `shell_type: "unified_exec"` gets `exec`, `wait` and `apply_patch` no matter which `--disable` flags you pass. That was found by capturing real requests with `RUST_LOG=trace`. A model asked to list its own tools invented one that didn't exist. So Rein rewrites the catalog:

1. If `<CODEX_HOME>/models_cache.json` is older than 24 hours, start a plain app-server, call `model/list` to refresh it, and stop it.
2. `writeReinCatalog()` writes `~/.rein/state/codex-catalog/<id>.json` (folder `0700`, file `0600`), a copy with every model's tool fields neutralized by `stripTools()` in `src/providers/codex/catalog.ts`:

   ```json
   {
     "tool_mode": null,
     "apply_patch_tool_type": null,
     "shell_type": "disabled",
     "experimental_supported_tools": [],
     "multi_agent_version": null,
     "node_repl_disabled": true,
     "supports_search_tool": false,
     "include_skills_usage_instructions": false,
     "include_plugin_usage_instructions": false,
     "include_apps_usage_instructions": false
   }
   ```

   `multi_agent_version: null` matters on its own: some models injected `spawn_agent`, `send_message` and friends from it even with the `multi_agent` feature off.

3. Start the real app-server with `appServerArgs()`. That's `--disable` for `apps`, `browser_use`, `browser_use_external`, `computer_use`, `image_generation`, `multi_agent`, `plugins`, `remote_plugin`, `shell_tool`, `unified_exec`, `view_image`, `goals`, `sleep_tool`, `tool_suggest`, `skill_search`, `collaboration_modes`, `hooks`, `in_app_browser`, `workspace_dependencies`, `worktrees` and `code_mode_host`, plus these `-c` overrides:

   ```text
   web_search="disabled"
   include_permissions_instructions=false
   include_collaboration_mode_instructions=false
   include_environment_context=false
   include_apps_instructions=false
   skills.include_instructions=false
   skills.bundled.enabled=false
   project_doc_max_bytes=0          # Rein already puts AGENTS.md in its own prompt
   model_catalog_json="~/.rein/state/codex-catalog/<id>.json"
   ```

4. `initialize` with `capabilities: {experimentalApi: true}`, which client-side dynamic tools need, then `initialized`.

The verified result: the only Codex tool left is `request_user_input`, and Rein answers it with `{answers: {}}`. First-turn input dropped to about 760 tokens.

### Threads and turns

```text
thread/start  {model, baseInstructions, personality: "none", approvalPolicy: "untrusted",
               sandbox: "read-only", cwd, ephemeral, dynamicTools: [...]}
turn/start    {threadId, input: [localImage…, text], model, effort}
turn/interrupt {threadId, turnId}
thread/resume {threadId, …same settings}
thread/fork   {threadId, ephemeral: true, excludeTurns: true, model, approvalPolicy, sandbox}
```

- **Model and effort travel with every `turn/start`**, so Codex switches both per turn with no reopen (`setEffort()` exists only on Codex sessions).
- Streaming comes as notifications: `item/agentMessage/delta` for text, `thread/tokenUsage/updated` for tokens (`last` is per request, summed across a tool-using turn), `item/completed` for generated images, `turn/completed` to finish, and `error` (ignored while `willRetry` is set).
- `account/rateLimits/read` and `account/rateLimits/updated` give usage for free. Windows are mapped **by duration** (`windowDurationMins`), not by primary/secondary position, because a free plan returns a single 30-day window.
- Errors are classified by `codexErrorInfo`: `usageLimitExceeded`, `rateLimitExceeded` and `sessionBudgetExceeded` count as `limit`, `contextWindowExceeded` as `context`, `serverOverloaded` as `overloaded`, and 401/403 as `auth`.

Per-thread `config` turns on `web_search: "live"` for web-search one-shots, and `features.image_generation` for `image_generate`. Every chat thread keeps both off.

### Defense in depth: declined approvals

If a future Codex model ever slipped a built-in tool past the catalog, it still couldn't do anything:

- `sandbox: "read-only"` on every thread and fork.
- `approvalPolicy: "untrusted"` turns tool use into approval requests.
- `declineServerRequest()` answers every `*requestApproval`, `applyPatchApproval` and `execCommandApproval` with `{decision: "decline"}`, routes `item/tool/call` to Rein's `ToolHost`, and rejects anything else with JSON-RPC `-32601`.

### Login

Codex accounts must be **ChatGPT logins**. `account/login/start {type: "chatgpt"}` returns an `authUrl` that completes through a localhost callback, with nothing to paste. Status comes from `account/read`, never `codex login status`, which reports "Logged in" even when the refresh token is dead. An API-key login shows as `unsupported auth type: apiKey` (or whatever type Codex reports).

## Protocol drift

Both protocols are undocumented or experimental, and the CLIs update themselves. Rein copes by:

- **Parsing defensively.** Unknown events are ignored. A limit error is recognized from `rate_limit_event.status` or from the result text (`hit your … limit`, `resets 3:45pm`, parsed by `parseResetTime()`), with a 15-minute cooldown when no reset time parses.
- **Never hardcoding models.** Both lists come from the CLIs, and cost tiers come from the models' own descriptions (`src/providers/tier.ts`).
- **Checking every new Codex against its own schema.** The first time Rein sees a `codex` version, `src/providers/codex/compat.ts` runs `codex app-server generate-json-schema --experimental` (no login, no tokens, well under a second) and checks it for every request, notification, server request and field Rein uses (the `REQUIRED` list: `thread/start` with `dynamicTools` and `baseInstructions`, `thread/fork` with `excludeTurns`, `item/tool/call`, `item/agentMessage/delta`, …). The result is cached per version in `~/.rein/state/codex-compat.json`.
  - **Incompatible:** Codex is **switched off** (its models leave the catalog, so routing and failover use Claude) and Rein says exactly what's missing, with two ways out: update Rein, or go back to the verified Codex line (`SUPPORTED_CODEX`, `0.160`). Chats never start on a protocol Rein can't drive.
  - **New tool-like model catalog fields** (a name matching tool, shell, exec, agent, browser… that Rein doesn't know) produce a warning: Rein can't strip what it doesn't know, though Codex threads stay read-only and Rein declines every approval request, so such tools still can't act.
- **Only disabling features Codex has.** Codex refuses to start on an unknown `--disable` name (`Unknown feature flag`). Rein reads `codex features list` with the same check and drops any of its 21 disabled features that a newer Codex removed or renamed, instead of taking Codex down.
- **`/update`** runs the same check right after `codex update`, plus a live `model/list`, and reports `Codex app-server protocol OK (everything Rein uses is there; N models)` or what's missing.
- **CI watches upstream.** `.github/workflows/codex-compat.yml` installs the newest `@openai/codex` every week (and on PRs touching the Codex driver) and runs `scripts/check-codex-compat.mts`, so a breaking Codex release shows up in Rein's CI before users update into it.
- **A re-verification script** for the tool stripping lives in `spikes/` (`verify-codex-tools.mts`, `codex-tools.py`), per PLAN.md §11.

## Related

- [Architecture](../architecture/): where the drivers sit
- [Context](../context/): what happens when a native session can't be reused
- [Load balancing](../load-balancing/): usage readings and account choice
- [Accounts](../../features/accounts/): adding and removing logins
- [Security](../../project/security/)
