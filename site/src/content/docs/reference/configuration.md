---
title: Configuration
description: Every key in ~/.rein/config.json with its type, default, meaning and the screen that sets it, plus a full example and the ten /settings tabs.
---

Rein keeps its settings in one small JSON file, `~/.rein/config.json` (or `$REIN_HOME/config.json`). Almost everything in it has a screen: `/model` for models, `/settings` for behaviour, `/tui` and `Ctrl+B` for layout. A few tuning knobs are file-only. Changes made in the UI save immediately and apply live, with no restart needed.

```json title="~/.rein/config.json"
{
  "version": 1,
  "chatModel": "auto",
  "decisionModel": "jev",
  "toolApproval": "auto",
  "loadBalancing": "balanced",
  "autoCompactPct": 80
}
```

Any key you leave out falls back to its default. Rein reads the file as `{...defaults, ...yourFile}` (`loadConfig` in `src/store/config.ts`), so a partial file is fine, and unknown keys are ignored.

:::tip
You rarely need to edit this file by hand. Use `/model` and `/settings`. Edit the file for the file-only keys below, then restart Rein (it reads the file at startup).
:::

## Models

These are set in [`/model`](../../features/routing/). Model values are refs of the form `provider:model`, for example `claude:sonnet` or `codex:gpt-5.5`. Use the ids `/model` shows you, because Codex model names depend on your plan.

| Key | Type | Default | Meaning | Set in |
| --- | --- | --- | --- | --- |
| `chatModel` | string | unset | The model that answers you. `"auto"` routes each message through the decision model; a ref pins one model. Unset means the provider default (Claude's default model if you have a Claude account, else Codex's default). | `/model` → Chat model, `/model <name>` |
| `chatEffort` | string | `"auto"` | Reasoning effort for the chat model. `"auto"` lets the decision model pick a level, but only when the prompt cache is cold anyway. `"default"` uses the model's own default. A level (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`) is clamped to the closest level the model supports at or below it. | `/model` → effort picker after choosing a chat model |
| `defaultModel` | string | unset | Fallback when auto routing isn't confident (below `autoMinConfidence`) or nothing is pinned. Unset means the provider default. | File only |
| `decisionModel` | string | `"cheapest"` | Routes `auto`, judges approvals in auto mode, checks goals and subagents. `"jev"`, `"cheapest"` or a ref. `"jev"` with no Jev key behaves like `"cheapest"`. Any Jev failure falls back to the cheapest model. | `/model` → Decision model |
| `compactionModel` | string | `"cheapest"` | Summarizes the conversation (`/compact`, auto-compact, handoffs) and picks which tool results travel when a conversation moves. `"cheapest"` or a ref. | `/model` → Compaction model |
| `advisorModel` | string | `"off"` | The stronger model agents can consult with the `advisor` tool. `"off"` hides the tool entirely. Never auto. | `/model` → Advisor |
| `webModel` | string | `"cheapest"` | Runs `web_search` with its provider's built-in search, and answers `web_fetch` prompts. | `/model` → Web |
| `subagentModel` | string | `"auto"` | Your model for `new`-mode subagents. `"auto"` means you haven't chosen one. Forks always keep the parent's model. | `/model` → Subagents |
| `subagentPriority` | `"user"` \| `"agent"` | `"user"` | Order used to choose a new subagent's model. `user`: your model, then the agent's choice, then auto. `agent`: the agent's choice, then your model, then auto. | `/model` → Subagent priority |
| `jevModel` | string | `"jev-1.13.0"` | The pinned Jev model id. Pinning keeps the decision thresholds calibrated. | File only |

"Cheapest available" is the lowest cost tier that has a healthy account, with ties going to the account with the most room. It re-resolves automatically as accounts hit limits. See [the decision model](../../internals/decision-model/).

:::note
Changing `advisorModel`, `subagentModel` or `subagentPriority` changes which tools exist (or their schemas), so Rein reloads the agent's tool list on the next turn. The conversation resumes in the same native session with the new tools.
:::

## Routing and accounts

| Key | Type | Default | Meaning | Set in |
| --- | --- | --- | --- | --- |
| `loadBalancing` | `"balanced"` \| `"sticky"` | `"balanced"` | `balanced` moves a conversation to a better account only at cache-cold moments or near a limit. New chats and subagents start on the least-used account. `sticky` stays on one account until it is limited. | `/settings` → Load balancing |
| `autoSwitchThreshold` | number (0–1) | `0.7` | Mid-conversation, auto routing switches models only when the decider's "is this a different kind of task?" probability is at least this. Below it, the current model keeps the conversation (and its warm cache). | File only |
| `autoMinConfidence` | number (0–1) | `0.45` | Below this confidence in its model choice, auto routing uses the default model instead. | File only |
| `maxUsedPct` | number (0–100) | `98` | An account counts as exhausted at this used %. An account is healthy only while its tightest window has more than `100 − maxUsedPct` points of headroom. An account with no usage data yet counts as 50% headroom, so it stays healthy. | File only |

How these play together is covered in [load balancing](../../internals/load-balancing/) and [routing](../../features/routing/).

## Tools and approvals

| Key | Type | Default | Meaning | Set in |
| --- | --- | --- | --- | --- |
| `toolApproval` | `"ask"` \| `"auto"` \| `"bypass"` | `"ask"` | What happens when the agent calls a tool that changes things: file writes, edits and deletes, plus `shell`, `image_generate`, `mcp_add`/`mcp_remove` and MCP tools without `readOnlyHint`. `ask` prompts you. `auto` lets the decision model allow changes that clearly match your request (p ≥ 0.85) and asks you about everything else. It never auto-denies. `bypass` allows all, except credentials outside the project, which always ask. Also the default for `rein -p --permission-mode`. | `/settings` → Approvals |
| `worktrees` | string | `"auto"` | `auto`: subagents working alongside other work get their own git worktree, merged back when they finish. `off`: subagents always edit the project directly. | `/settings` → Worktrees |
| `apiAccounts` | string | `"fallback"` | When pay-per-use API accounts (Console, Bedrock, Vertex, OpenAI key) are used. `fallback`: only when no subscription account can serve the model. `always`: alongside subscriptions, after them. Subscriptions always come first. | `/settings` → API accounts |
| `sandbox` | string | `"write"` | OS sandbox around the agent's shell commands. `write`: commands can only write inside the project, its working directories, the session scratchpad, temp folders and package caches (git hooks/config and agent/editor settings stay read-only). `strict`: the same, and no network except localhost. `off`: no sandbox. macOS uses `sandbox-exec`, Linux bubblewrap; Windows runs unsandboxed. | `/settings` → Sandbox |
| `shellMaxMinutes` | number | `120` | Longest a foreground shell command may run. The agent picks a timeout per command (2 minutes by default) up to this cap. `0` = no limit. Background commands have no limit. | `/settings` → Shell |
| `backgroundCheckMinutes` | number | `60` | Every this many minutes of a background command's life, a fork of the agent (like `/btw`) checks whether it's still needed and stops it if not. Unsure keeps it running. `0` = off. | `~/.rein/config.json` |
| `additionalDirectories` | string[] | `[]` | Extra working directories. Tools use them without asking, like the project folder. Relative paths resolve against the project, `~/` against your home folder. Directories that don't exist are skipped. | File only (per session: `/add-dir`, `rein --add-dir`) |
| `subagentLimit` | number | `10` | How many subagents may run at once. The agent is told the limit. | `/settings` → Subagents |
| `goalMaxRounds` | number | `0` | Automatic continuations a `/goal` may take before it pauses itself. `0` = unlimited. | `/settings` → Goals |
| `autoCompactPct` | number | `80` | Auto-compact when the context reaches this % of the model's window, including in the middle of a turn (the agent carries on from the summary). `0` = off (only `/compact`, or when a model rejects a full context). | `/settings` → Compaction |
| `notifications` | string | `"terminal"` | Get your attention when Rein needs you (an approval, a question, a plan, project hooks to trust) or finishes work that took 20 s or more. `terminal`: bell plus an OSC 9 notification (iTerm2, WezTerm, kitty, Ghostty, Windows Terminal). `system`: also a desktop notification (macOS Notification Center, `notify-send` on Linux). `off`. | `/settings` → Notifications |

See [permissions](../../features/permissions/) for rules, plan mode and the full approval pipeline.

## App and layout

| Key | Type | Default | Meaning | Set in |
| --- | --- | --- | --- | --- |
| `autoUpdate` | boolean | `true` | On launch, check npm for a newer Rein and install it in the background. It takes effect on the next start. `REIN_NO_AUTOUPDATE` also turns it off. | `/settings` → Updates |
| `hidePersonalInfo` | boolean | `true` | Privacy mode. Accounts show as "Claude Account 1" / "Codex Account 1", known emails in rendered text become those names, your home folder becomes `~` and your username becomes `user`. | `/settings` → Privacy |
| `tui` | `"fullscreen"` \| `"classic"` | unset (= fullscreen) | The renderer. `rein --classic` / `--fullscreen` override it for one run without saving. | `/tui fullscreen`, `/tui classic` |
| `sidebar` | boolean | unset (= shown) | Whether the fullscreen sidebar is open. It auto-hides below 96 columns regardless. | `Ctrl+B` or the `[≡]` button |
| `statusLine` | string[] | `["model","account","usage","context","sidebarToggle"]` | Top status line segments, left to right. | `/settings` → Status line |
| `sidebarSections` | string[] | `["agents","accounts","models","session"]` | Sidebar sections, top to bottom. | `/settings` → Sidebar |
| `version` | `1` | `1` | File format version. Leave it alone. | — |

Valid `statusLine` ids (from `STATUS_ITEMS` in `src/ui/layout.ts`):

| Id | Shows |
| --- | --- |
| `model` | Chat model (auto shows the routed model). Click: `/model` |
| `account` | Account serving the conversation. Click: `/usage` |
| `usage` | That account's usage windows (5h / weekly / …) |
| `context` | Context window fill %. Click: `/context` |
| `decider` | Jev or the LLM that routes auto mode |
| `messages` | Messages in this conversation |
| `advisor` | Advisor model (or off) |
| `approvals` | Approval mode (ask / auto / bypass) |
| `sidebarToggle` | `[≡]` toggles the sidebar |

Valid `sidebarSections` ids: `agents`, `accounts`, `models` (chat model picker), `context`, `routing` (last auto-routing decision), `session`, `shortcuts`. GOAL and TASKS sections appear on their own when a goal or task list exists. Unknown ids are dropped silently, so a config from a newer or older Rein still loads.

## The `/settings` tabs

`/settings` opens a window with tabs. Switch with click, `←` `→` or `Tab`. Close with `Esc`.

| Tab | Key | Choices |
| --- | --- | --- |
| **Status line** | `statusLine` | Toggle segments (click / `Space`), reorder (`▲▼`, `Shift+↑↓` or `[` `]`), `r` resets |
| **Sidebar** | `sidebarSections` | Same controls as Status line |
| **Approvals** | `toolApproval` | Ask *(default)* · Auto · Bypass |
| **Shell** | `shellMaxMinutes` | 10 minutes · 30 minutes · 1 hour · 2 hours *(default)* · 4 hours · 8 hours · No limit |
| **Subagents** | `subagentLimit` | 1 · 2 · 3 · 5 · 10 *(default)* · 20 at a time |
| **Goals** | `goalMaxRounds` | Unlimited *(default)* · 10 · 25 · 50 · 100 · 250 continuations |
| **Load balancing** | `loadBalancing` | Balanced *(default, cache-aware)* · Sticky |
| **Sandbox** | `sandbox` | On *(default)* · Strict · Off |
| **Worktrees** | `worktrees` | Automatic *(default)* · Off |
| **API accounts** | `apiAccounts` | Fallback *(default)* · Always |
| **Notifications** | `notifications` | Terminal *(default)* · Desktop · Off |
| **Updates** | `autoUpdate` | Auto-update Rein *(default)* · Only when I run `/update` |
| **Privacy** | `hidePersonalInfo` | Hide personal info *(default)* · Show emails and paths |
| **Compaction** | `autoCompactPct` | Off · 50 · 60 · 70 · 80% *(default)* · 90 · 95% |

## A full example

Every key, with defaults where it makes sense and realistic values for the optional ones:

```json title="~/.rein/config.json"
{
  "version": 1,
  "chatModel": "auto",
  "chatEffort": "auto",
  "defaultModel": "claude:sonnet",
  "decisionModel": "jev",
  "compactionModel": "cheapest",
  "advisorModel": "claude:opus",
  "webModel": "cheapest",
  "subagentModel": "auto",
  "subagentPriority": "user",
  "jevModel": "jev-1.13.0",

  "loadBalancing": "balanced",
  "autoSwitchThreshold": 0.7,
  "autoMinConfidence": 0.45,
  "maxUsedPct": 98,

  "toolApproval": "ask",
  "sandbox": "write",
  "apiAccounts": "fallback",
  "worktrees": "auto",
  "shellMaxMinutes": 120,
  "backgroundCheckMinutes": 60,
  "additionalDirectories": ["../shared-lib", "~/notes"],
  "subagentLimit": 10,
  "goalMaxRounds": 0,
  "autoCompactPct": 80,

  "autoUpdate": true,
  "notifications": "terminal",
  "hidePersonalInfo": true,
  "tui": "fullscreen",
  "sidebar": true,
  "statusLine": ["model", "account", "usage", "context", "approvals", "sidebarToggle"],
  "sidebarSections": ["agents", "accounts", "models", "context", "session"]
}
```

:::caution
JSON has no comments. A syntax error makes Rein fail to read the file. The file is written atomically (temp file + rename), so Rein itself never leaves it half-written.
:::

## Related

- [Models & routing](../../features/routing/): the `/model` screen in detail
- [Permissions](../../features/permissions/): approval modes, rules and plan mode
- [Files & environment](../files/): where this file lives and what else is in `~/.rein`
- [Load balancing](../../internals/load-balancing/): what `loadBalancing` and `maxUsedPct` actually do
- [The decision model](../../internals/decision-model/): every place `decisionModel` is used
