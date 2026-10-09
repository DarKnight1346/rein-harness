---
title: Configuration
description: Every key in ~/.rein/config.json with its type, default, meaning and the screen that sets it, plus a full example and the /settings tabs.
---

Rein keeps its settings in one small JSON file, `~/.rein/config.json` (or `$REIN_HOME/config.json`). Every key can be changed inside Rein: `/model` for models, `/settings` for behaviour, `/tui` and `Ctrl+B` for layout, and **`/settings <key> <value>`** or **`/settings` → Advanced** for any key, including the tuning knobs. Changes made in Rein save immediately and apply live, with no restart needed.

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
You rarely need to edit this file by hand. `/settings keys` lists every key; `/settings <key>` explains one; `/settings <key> <value>` changes it (`true`/`false`, a number, one of the listed choices, a comma-separated list, or JSON for objects); `/settings <key> reset` restores the default. If you do edit the file, restart Rein (it reads the file at startup).
:::

## Models

These are set in [`/model`](../../features/routing/). Model values are refs of the form `provider:model`, for example `claude:sonnet` or `codex:gpt-5.5`. Use the ids `/model` shows you, because Codex model names depend on your plan.

| Key | Type | Default | Meaning | Set in |
| --- | --- | --- | --- | --- |
| `chatModel` | string | unset | The model that answers you. `"auto"` routes each message through the decision model; a ref pins one model. Unset means the provider default (Claude's default model if you have a Claude account, else Codex's default). | `/model` → Chat model, `/model <name>` |
| `chatEffort` | string | `"auto"` | Reasoning effort for the chat model. `"auto"` lets the decision model pick a level, but only when the prompt cache is cold anyway. `"default"` uses the model's own default. A level (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`) is clamped to the closest level the model supports at or below it. | `/model` → effort picker after choosing a chat model |
| `defaultModel` | string | unset | Fallback when auto routing isn't confident (below `autoMinConfidence`) or nothing is pinned. Unset means the provider default. | `/settings <key>`, `/settings` → Advanced |
| `decisionModel` | string | `"cheapest"` | Routes `auto`, judges approvals in auto mode, checks goals and subagents. `"jev"`, `"cheapest"` or a ref. `"jev"` with no Jev key behaves like `"cheapest"`. Any Jev failure falls back to the cheapest model. | `/model` → Decision model |
| `compactionModel` | string | `"cheapest"` | Summarizes the conversation (`/compact`, auto-compact, handoffs) and picks which tool results travel when a conversation moves. `"cheapest"` or a ref. | `/model` → Compaction model |
| `advisorModel` | string | `"off"` | The stronger model agents can consult with the `advisor` tool. `"off"` hides the tool entirely. Never auto. | `/model` → Advisor |
| `webModel` | string | `"cheapest"` | Runs `web_search` with its provider's built-in search, and answers `web_fetch` prompts. | `/model` → Web |
| `subagentModel` | string | `"auto"` | Your model for `new`-mode subagents. `"auto"` means you haven't chosen one. Forks always keep the parent's model. | `/model` → Subagents |
| `subagentPriority` | `"user"` \| `"agent"` | `"user"` | Order used to choose a new subagent's model. `user`: your model, then the agent's choice, then auto. `agent`: the agent's choice, then your model, then auto. | `/model` → Subagent priority |
| `jevModel` | string | `"jev-1.13.0"` | The pinned Jev model id. Pinning keeps the decision thresholds calibrated. | `/settings <key>`, `/settings` → Advanced |

"Cheapest available" is the lowest cost tier that has a healthy account, with ties going to the account with the most room. It re-resolves automatically as accounts hit limits. See [the decision model](../../internals/decision-model/).

:::note
Changing `advisorModel`, `subagentModel` or `subagentPriority` changes which tools exist (or their schemas), so Rein reloads the agent's tool list on the next turn. The conversation resumes in the same native session with the new tools.
:::

## Routing and accounts

| Key | Type | Default | Meaning | Set in |
| --- | --- | --- | --- | --- |
| `loadBalancing` | `"balanced"` \| `"sticky"` | `"balanced"` | `balanced` moves a conversation to a better account only at cache-cold moments or near a limit. New chats and subagents start on the least-used account. `sticky` stays on one account until it is limited. | `/settings` → Accounts → Load balancing |
| `autoSwitchThreshold` | number (0–1) | `0.7` | Mid-conversation, auto routing switches models only when the decider's "is this a different kind of task?" probability is at least this. Below it, the current model keeps the conversation (and its warm cache). | `/settings <key>`, `/settings` → Advanced |
| `autoMinConfidence` | number (0–1) | `0.45` | Below this confidence in its model choice, auto routing uses the default model instead. | `/settings <key>`, `/settings` → Advanced |
| `maxUsedPct` | number (0–100) | `98` | An account counts as exhausted at this used %. An account is healthy only while its tightest window has more than `100 − maxUsedPct` points of headroom. An account with no usage data yet counts as 50% headroom, so it stays healthy. | `/settings <key>`, `/settings` → Advanced |

How these play together is covered in [load balancing](../../internals/load-balancing/) and [routing](../../features/routing/).

## Tools and approvals

| Key | Type | Default | Meaning | Set in |
| --- | --- | --- | --- | --- |
| `toolApproval` | `"ask"` \| `"auto"` \| `"bypass"` | `"ask"` | What happens when the agent calls a tool that changes things: file writes, edits and deletes, plus `shell`, `image_generate`, `mcp_add`/`mcp_remove` and MCP tools without `readOnlyHint`. `ask` prompts you. `auto` lets the decision model allow changes that clearly match your request (p ≥ 0.85) and asks you about everything else. It never auto-denies. `bypass` allows all, except credentials outside the project, which always ask. Also the default for `rein -p --permission-mode`. | `/settings` → General → Approvals |
| `worktrees` | string | `"auto"` | `auto`: subagents working alongside other work get their own git worktree, merged back when they finish. `off`: subagents always edit the project directly. | `/settings` → Agents → Worktrees |
| `lsp` | `"auto"` \| `"off"` | `"auto"` | Built-in [code intelligence](../../features/code-intelligence/): Rein runs language servers itself and, when the agent finishes a turn, sends back problems its changes left. `"off"` never starts one. | `/settings <key>`, `/settings` → Advanced |
| `lspIdleMinutes` | number | `10` | Stop a built-in language server after this many minutes unused. | `/settings <key>`, `/settings` → Advanced |
| `prices` | object | `{}` | USD per million tokens for models without a built-in price, or to replace one: `{"codex:my-model": {"input": 1.5, "cached": 0.15, "output": 6}}` (`write5m`, `write1h` optional). See [Cost & budgets](../../features/cost/). | `/settings <key>`, `/settings` → Advanced |
| `goalConfirmUsd` | number | `0` | When goals in this project have typically cost more than this (USD, API prices), `/goal` shows the estimate and waits for you to send it again. `0` = never asks. See [Goal estimates](../../features/cost/#goal-estimates). | `/settings goalConfirmUsd`, `/settings` → Advanced |
| `budget` | object | unset (no caps) | Spending caps in USD at API list prices: `{"requestUsd": 2, "goalUsd": 20, "conversationUsd": 50}`. A repo's `.rein/settings.json` `budget` can set lower ones. See [Cost & budgets](../../features/cost/#budgets). | `/settings budget {…}`, `/settings` → Advanced |
| `otel` | object | unset (off) | OpenTelemetry export of turns, tool calls, tokens and cost: `{"endpoint": "http://localhost:4318", "headers": {…}, "serviceName": "rein"}`. Metadata only. See [Observability](../../features/observability/). | `/settings <key>`, `/settings` → Advanced |
| `experiments` | string[] | `[]` | Efficiency experiments to turn on by name, or `-name` to turn a default one off; see [Experiments](#experiments). | `/settings <key>`, `/settings` → Advanced |
| `lspServers` | object | — | Use your own server command instead of Rein's, per server id: `{"python": {"command": "/path/to/server", "args": ["--stdio"]}}`. | `/settings <key>`, `/settings` → Advanced |
| `waitForLimits` | boolean | `true` | When every account for the model is at its limit and no other model can take over, wait for the earliest reset (up to 12 hours) and continue the turn. `false` stops with `Every account for … is at its limit`. | `/settings` → Accounts → Limits |
| `secretScan` | `"off"` \| `"warn"` \| `"block"` | `"off"` | A `write` or `edit` that adds something that looks like a credential: tell the agent (`warn`) or refuse the change (`block`). When on, credentials are also masked in saved conversations. See [Secret scanning](../../features/permissions/#secret-scanning). | `/settings secretScan`, `/settings` → Advanced |
| `sast` | `"off"` \| `"semgrep"` | `"off"` | At the end of a turn, run Semgrep (when installed) on the files the request changed; findings on added lines go back to the agent. See [Static analysis with Semgrep](../../features/code-intelligence/#static-analysis-with-semgrep). | `/settings sast`, `/settings` → Advanced |
| `sastConfig` | string | `"auto"` | Semgrep rules: `auto`, a registry pack like `p/owasp-top-ten`, or a path to your own rules. | `/settings sastConfig`, `/settings` → Advanced |
| `injectionScan` | boolean | `false` | Flag instructions planted in `web_fetch`, `web_search` and MCP results; the agent is told they're data and you see a warning. See [Safety guards](../../features/safety/#planted-instructions-injectionscan). | `/settings injectionScan`, `/settings` → Advanced |
| `exfilGuard` | boolean | `false` | Once a conversation has seen outside content and private data, calls that can send data out (`web_fetch`, MCP, `curl`, `git push`…) need your yes, even in bypass. See [Safety guards](../../features/safety/#data-leaving-the-machine-exfilguard). | `/settings exfilGuard`, `/settings` → Advanced |
| `depCheck` | `"off"` \| `"warn"` \| `"block"` | `"off"` | Vet packages a change adds (manifest edits and install commands): does it exist, is it a typosquat, its license, known vulnerabilities. Looks them up on the registries and OSV. See [Safety guards](../../features/safety/#new-dependencies-depcheck). | `/settings depCheck`, `/settings` → Advanced |
| `buildTimeWarnings` | boolean | `true` | Warn you (not the agent) when a build or test command takes 1.5× its usual time and at least 30 s more. See [Slower builds](../../features/build-and-test/#slower-builds). | `/settings buildTimeWarnings`, `/settings` → Advanced |
| `steerShell` | boolean | `true` | Run the agent's simple shell reads and searches (`cat F`, `head`/`tail`, `sed -n 'A,Bp' F`, `ls`, `grep -rn`, `rg`, `find -name`) as the built-in `read` / `list` / `search` tools. See [Tools](../../features/tools/#reads-and-searches-run-as-tools). | `/settings <key>`, `/settings` → Advanced |
| `mcpPinning` | boolean | `false` | Remember each MCP server's launch config and tools when it first connects; if either changes later, its tools are held until you accept it in `/mcp`. See [Safety guards](../../features/safety/#changed-mcp-servers-mcppinning). | `/settings mcpPinning`, `/settings` → Advanced |
| `mcpSampling` | `"ask"` \| `"allow"` \| `"off"` | `"ask"` | MCP servers asking for a completion ([sampling](../../features/mcp/#sampling-servers-can-use-your-models)) get one from your subscriptions: after you approve each server, without asking, or never. | `/settings <key>`, `/settings` → Advanced |
| `inlineImages` | `"auto"` \| `"off"` | `"auto"` | Show images the agent generates or reads in the terminal, where it can draw them (kitty, Ghostty; iTerm2 and WezTerm in the classic renderer). See [Seeing images in the terminal](../../features/web-and-images/#seeing-images-in-the-terminal). | `/settings <key>`, `/settings` → Advanced |
| `rtl` | `"auto"` \| `"on"` \| `"off"` | `"auto"` | Lay out right-to-left text (Hebrew, Arabic) for display in terminals that don't do it themselves. See [Math and right-to-left text](../../features/tui/#math-and-right-to-left-text). | `/settings <key>`, `/settings` → Advanced |
| `remoteHost` | string | `"127.0.0.1"` | Address the [remote page](../../features/remote/) listens on. The default is this computer only; `"0.0.0.0"` is your network (Rein warns). | `/settings <key>`, `/settings` → Advanced |
| `remotePort` | number | `7377` | Port of the remote page. | `/settings <key>`, `/settings` → Advanced |
| `trackers` | array | `[]` | [Issue trackers](../../features/trackers/) that hand work to Rein: `{kind: "github" \| "linear" \| "gitlab" \| "azure" \| "jira", project, url, email, label, model}`. Tokens go in the vault. | `/settings <key>`, `/settings` → Advanced |
| `trackerPollMinutes` | number | `2` | How often Rein looks for new issues. | `/settings <key>`, `/settings` → Advanced |
| `notifyUrl` | string | `""` | Notifications on your phone: a URL Rein POSTs to when an approval has waited 30 s, and when work that took a while is done. [ntfy](https://ntfy.sh) (`https://ntfy.sh/your-topic`), Slack and Discord incoming webhooks are formatted for them; anything else gets `{"title", "message"}` JSON. See [Phone notifications](../../features/tui/#phone-notifications). | `/settings <key>`, `/settings` → Advanced |
| `attribution` | boolean | `true` | Commits and pull requests the agent writes end with the line `Co-Authored by [Rein Harness](https://github.com/DarKnight1346/rein-harness)` (Rein's system prompt asks for it). `false` drops the instruction. | `/settings` → General → Attribution |
| `provenance` | boolean | `false` | Commits and PRs the agent makes end with `Rein-Session`, `Rein-Model` and `Rein-Goal` trailers, filled in by the shell. See [Provenance](../../features/pull-requests/#provenance-on-agent-commits). | `/settings provenance`, `/settings` → Advanced |
| `prMaxLines` | number | `0` | Tell you (not the agent) when the branch changes more lines than this against its base. `0` = off. See [Smaller PRs](../../features/pull-requests/#smaller-prs). | `/settings prMaxLines`, `/settings` → Advanced |
| `planReview` | `"off"` \| `"other"` \| `"advisor"` | `"off"` | A second model critiques each plan (and a spec's design) before you see it, once per planning session; the agent folds in what holds up and presents it again. `other`: the other provider's best available model. `advisor`: `advisorModel`. See [A second opinion on the plan](../../features/plans/#a-second-opinion-on-the-plan). | `/settings` → Agents → Plan review |
| `codeSearch` | object | unset | Org-wide code search for the agent's `org_search` tool: `{"type": "sourcegraph", "url": "https://sourcegraph.example.com"}` or `"type": "zoekt"` with the Zoekt webserver's URL. Sourcegraph's token comes from `SRC_ACCESS_TOKEN`. See [Search the whole org](../../features/large-codebases/#search-the-whole-org). | `/settings codeSearch`, `/settings` → Advanced |
| `semanticIndex` | object | unset | Local semantic search through Ollama. `{}` uses `nomic-embed-text` at `http://127.0.0.1:11434`; set `model` or `url` to change them. Once set and `/index` has run, the agent gets `semantic_search`. See [Search by meaning](../../features/large-codebases/#search-by-meaning). | `/settings semanticIndex`, `/settings` → Advanced |
| `voiceModel` | string | `"base.en-q5_1"` | The whisper.cpp model for [voice input](../../features/voice/). English-only by default; `"base-q5_1"`, `"small-q5_1"` and so on understand other languages. Run `/voice setup` after changing it to download it. | `/settings <key>`, `/settings` → Advanced |
| `collapsePastes` | boolean | `true` | Big pastes (more than 3 lines or 800 characters) show in the input as a `[Pasted text #1 +40 lines]` placeholder and are sent in full with your message. `false` pastes the text into the input as-is. | `/settings` → General → Paste |
| `apiAccounts` | string | `"fallback"` | When pay-per-use API accounts (Console, Bedrock, Vertex, OpenAI key) are used. `fallback`: only when no subscription account can serve the model. `always`: alongside subscriptions, after them. Subscriptions always come first. | `/settings` → Accounts → API accounts |
| `sandbox` | string | `"write"` | OS sandbox around the agent's shell commands. `write`: commands can only write inside the project, its working directories, the session scratchpad, temp folders and package caches (git hooks/config and agent/editor settings stay read-only). `strict`: the same, and no network except localhost. `off`: no sandbox. macOS uses `sandbox-exec`, Linux bubblewrap; Windows runs unsandboxed. | `/settings` → General → Sandbox |
| `shellMaxMinutes` | number | `120` | Longest a foreground shell command may run. The agent picks a timeout per command (2 minutes by default) up to this cap. `0` = no limit. Background commands have no limit. | `/settings` → General → Shell |
| `backgroundCheckMinutes` | number | `60` | Every this many minutes of a background command's life, a fork of the agent (like `/btw`) checks whether it's still needed and stops it if not. Unsure keeps it running. `0` = off. | `/settings <key>`, `/settings` → Advanced |
| `additionalDirectories` | string[] | `[]` | Extra working directories. Tools use them without asking, like the project folder. Relative paths resolve against the project, `~/` against your home folder. Directories that don't exist are skipped. | `/settings <key>`, `/settings` → Advanced (per session: `/add-dir`, `rein --add-dir`) |
| `subagentLimit` | number | `10` | How many subagents may run at once. The agent is told the limit. | `/settings` → Agents → Subagents |
| `goalMaxRounds` | number | `0` | Automatic continuations a `/goal` may take before it pauses itself. `0` = unlimited. | `/settings` → Agents → Goals |
| `autoCompactPct` | number | `80` | Auto-compact when the context reaches this % of the model's window, including in the middle of a turn (the agent carries on from the summary). `0` = off (only `/compact`, or when a model rejects a full context). | `/settings` → Agents → Compaction |
| `contextWarnings` | boolean | `true` | Say when the context passes 50%, 70% and 85% of the window, and which tool results take the most space. See [Context warnings](../../internals/context/#context-warnings). | `/settings contextWarnings`, `/settings` → Advanced |
| `notifications` | string | `"terminal"` | Get your attention when Rein needs you (an approval, a question, a plan, project hooks to trust) or finishes work that took 20 s or more. `terminal`: bell plus an OSC 9 notification (iTerm2, WezTerm, kitty, Ghostty, Windows Terminal). `system`: also a desktop notification (macOS Notification Center, `notify-send` on Linux). `off`. | `/settings` → General → Notifications |

See [permissions](../../features/permissions/) for rules, plan mode and the full approval pipeline.

## App and layout

| Key | Type | Default | Meaning | Set in |
| --- | --- | --- | --- | --- |
| `autoUpdate` | boolean | `true` | On launch, check npm for a newer Rein and install it in the background. It takes effect on the next start. `REIN_NO_AUTOUPDATE` also turns it off. | `/settings` → General → Updates |
| `hidePersonalInfo` | boolean | `true` | Privacy mode. Accounts show as "Claude Account 1" / "Codex Account 1", known emails in rendered text become those names, your home folder becomes `~` and your username becomes `user`. | `/settings` → General → Privacy |
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

`/settings` opens a window with seven tabs. Switch with click, `←` `→` or `Tab`; close with `Esc`. `/settings <tab>` (`/settings safety`) opens on that tab.

| Tab | What's in it |
| --- | --- |
| **Status line** | `statusLine`: toggle segments (click / `Space`), reorder (`▲▼`, `Shift+↑↓` or `[` `]`), `r` resets |
| **Sidebar** | `sidebarSections`: same controls as Status line |
| **General** | Approvals (`toolApproval`), Sandbox (`sandbox`), Shell (`shellMaxMinutes`), Notifications (`notifications`), Paste (`collapsePastes`), Attribution (`attribution`), Updates (`autoUpdate`), Privacy (`hidePersonalInfo`) |
| **Agents** | Subagents (`subagentLimit`), Goals (`goalMaxRounds`), Worktrees (`worktrees`), Compaction (`autoCompactPct`), Plan review (`planReview`) |
| **Accounts** | Load balancing (`loadBalancing`), Limits (`waitForLimits`), API accounts (`apiAccounts`) |
| **Safety** | Secrets (`secretScan`), Semgrep (`sast`), Planted instructions (`injectionScan`), Data leaving (`exfilGuard`), MCP pinning (`mcpPinning`), Dependencies (`depCheck`) |
| **Advanced** | Every key in the file as a list: `Enter` cycles a choice or on/off, or opens an editor for text, numbers, lists (comma-separated) and JSON; `r` resets the key to its default |

In General, Agents, Accounts and Safety, `↑` `↓` pick a setting, and `Enter`, `Space` or a click cycles its value. The focused setting's explanation and all its choices show below the list; click a choice to pick it.

| Setting | Choices |
| --- | --- |
| Approvals | Ask *(default)* · Auto · Bypass |
| Sandbox | On *(default)* · Strict · Off |
| Shell | 10 minutes · 30 minutes · 1 hour · 2 hours *(default)* · 4 hours · 8 hours · No limit |
| Notifications | Terminal *(default)* · Desktop · Off |
| Paste | Placeholder *(default)* · Plain text |
| Attribution | On *(default)* · Off |
| Updates | Auto-update Rein *(default)* · Only when I run `/update` |
| Privacy | Hide personal info *(default)* · Show emails and paths |
| Subagents | 1 · 2 · 3 · 5 · 10 *(default)* · 20 at a time |
| Goals | Unlimited *(default)* · 10 · 25 · 50 · 100 · 250 continuations |
| Worktrees | Automatic *(default)* · Off |
| Compaction | Off · 50 · 60 · 70 · 80% *(default)* · 90 · 95% |
| Plan review | Off *(default)* · Other provider · Advisor |
| Load balancing | Balanced *(default, cache-aware)* · Sticky |
| Limits | Wait for the reset and continue *(default)* · Stop and tell me |
| API accounts | Fallback *(default)* · Always |
| Secrets, Dependencies | Off *(default)* · Warn · Block |
| Semgrep | Off *(default)* · Semgrep |
| Planted instructions, Data leaving, MCP pinning | Off *(default)* · On |

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

## Moving to another machine

`/settings export [file]` writes one file (`rein-settings.json` by default, `0600`) with what you've set up:

- `config.json`, `settings.json` (permission rules and hooks), `mcp.json`, `AGENTS.md`, `system-prompt.md`;
- your `skills/` and `agents/` folders.

**Never in it:** accounts and logins, the [vault](../../features/vault/), the Jev key. Values written literally into an MCP server's `env` or `headers` (tokens, mostly) are left out too, and the export lists them so you can set them again. `${VAR}` references stay, so they work wherever the variable is set.

On the other machine, `/settings import rein-settings.json` writes the files into its settings folder. A file that exists and differs is kept as `<name>.before-import` first. Restart Rein to load everything.

## Experiments

Changes meant to cut what a task costs (tokens, round trips, time), measured with and without on the same tasks. Those that paid off are on by default: `lean-subagents`, `compact-read`, `outline-reads`, `shell-cap` and `faithful-compaction` everywhere, and in [`rein -p`](../../features/headless/), where they were measured, also `lazy-tools`, `no-todo`, `brief-final`, `context-cap`, `cache-5m` and `verify-requirements` (a one-off run has no idle pauses, no one reading a task list or a long final reply, and is long enough that a turn checking every requirement is cheap next to it). Together, on 15 large tasks taken from real pull requests and run with `rein -p`, they cost about a quarter less per solved task than plain Claude Code with the same model, took about a fifth less time, and solved slightly more. The rest are off unless listed in `experiments`. Put `-name` in `experiments` to turn a default one off, for example `["-shell-cap"]`.

| Name | What it does |
|---|---|
| `reread-unchanged` | Reading a whole file again that the model already read in this conversation, and that hasn't changed since, returns a one-line note instead of the file. Only while the same model session is running: after compaction, failover or a model switch the earlier read is gone, so the file is sent again. Reads of a range (`offset` / `limit`) always return the text. |
| `quiet-passing-output` | A build or test command (`npm test`, `tsc`, `pytest`, `go test`, `cargo test`, `make`…) that exits 0 returns its last 25 lines, where the summary is, with a note that earlier lines were left out. Failing commands and other commands return their full output. |
| `todo-piggyback` | `edit`, `write` and `shell` also take `todos`, the updated task list, so ticking off a task rides along with the call that finished it instead of a separate `todo_write` round trip. |
| `lazy-tools` | Tools a coding task rarely needs (`skill`, `agent`, `decide`, the MCP tools, `web_search`, `web_fetch`, `image_generate`, memory and past-session tools, `lsp_install`) leave the model's tool list, about 3,000 tokens a request. One `tool` entry lists them by name: `tool {name}` shows what one takes, `tool {name, args}` runs it, with the same approvals. |
| `no-todo` | No task list: `todo_write` leaves the tool list and the system prompt. Some models update a list after every step, each a round trip; this measures what the list costs. |
| `lean-subagents` | The `agent` tool says what a subagent costs (its own context: instructions, tools, everything it reads) and that one focused change is better done directly than split across subagents. |
| `in-scope` | One line in the system prompt: do what was asked and no more (update the code and tests the change affects; no new test files, refactors or features the request doesn't need). |
| `self-test` | One line in the system prompt: before finishing a code change, run the project's tests (or build) and fix what fails, and do the checking yourself rather than relying on a subagent's report. Always on for Codex models: Rein's prompt replaces Codex's own instructions, which ask for this, and without it Sol ran a fifth as many commands as in Codex and solved 3 of 15 large tasks against Codex's 7 (7 with it). Listing it turns it on for Claude models too. |
| `many-calls` | The system prompt's batching line becomes a stronger one: every response re-reads the whole conversation, so plan several steps ahead and make many tool calls in each response (all the reads, searches and edits you've decided on, and independent commands side by side), waiting for a result only when the next call depends on it. It also says the calls run in the order written, so edits and the test run can share a response. After 4 responses in a row that each made one call, a tool result carries a one-line reminder to batch; the next comes after 8 more, then 16. Measured without it, 83–87% of Claude models' requests carried a single tool call. |
| `outline-reads` | A `read` without `offset` / `limit` of a text file over 500 lines (also inside `paths`) returns the line count and an outline instead of the text: its declarations (functions, methods, classes, types, top-level constants, headings) with line numbers. The model then reads the ranges it needs, or passes `full: true` for the whole file. Files of 500+ lines were 77–89% of what whole-file reads put into the conversation, and everything read stays there for every later request. |
| `shell-cap` | A command whose output is over 8K characters returns its first 2K and last 5K characters, and the output is saved to a file in the session scratchpad (`shell-<id>.log`) that the result names, so the model can search or read any other part. Everything a command prints stays in the conversation for every later request. Rein keeps a command's first 200 lines and last 2,000. Without this, a long output returns only its last 30K characters. |
| `cross-review` | Once per request, when the agent is about to stop after changing files, the strongest available model from the *other* provider (Codex for a Claude conversation, Claude for a Codex one) reviews the diff and new files against the request. Concrete problems it finds go back to the agent to fix or dismiss. Needs both providers signed in; the reviewer's tokens count in the conversation's totals. |
| `self-review` | Like `cross-review`, but with the same model as the conversation, in a fresh call that sees only the request, the diff and new files (not the conversation). Once per request, when the agent is about to stop after changing files. See [A review before it's done](../../features/pull-requests/#a-review-before-its-done). |
| `verify-requirements` | Once per request, when the agent is about to stop after changing files (with its own tools or through the shell), Rein sends it back to go through the request line by line and run each requirement and edge case (a quick script or test, not a reread), fix what fails, then run the project's tests. If that pass changed the code, it checks once more against the final code. Usually one extra turn, against tasks that fail on the one requirement that was skipped. The end-of-turn code check runs after it. |
| `watchdog` | The main agent going in circles within one request: the same command failing again with no file changed in between, or a file edited back to a version it just had. At the 3rd time the tool result tells the agent to stop and rethink; at the 5th the call is refused with the reason. An edit between two runs of a command counts as progress and starts the count over. Your next message resets it. |
| `log-digest` | A failing shell command with a long output (80 lines or more) gets a digest in front: the failing step (GitHub Actions and GitLab sections, Gradle tasks), the first error lines and the `file:line` locations they name, then the full output. The CI watcher uses the same digest on failed checks. |
| `affected-tool` | In an Nx, Turborepo, Bazel or Pants workspace, the agent gets an `affected` tool: what a change affects, from the build graph, and the command that tests just that. See [Build & test](../../features/build-and-test/#what-a-change-affects). |
| `verify-affected` | In an Nx, Turborepo, Bazel or Pants workspace, at the end of a request that changed files: run the tests for the affected projects (through the `shell` tool, so approvals and the sandbox apply) and send failures back to the agent. Once per request. See [Testing what a request changed](../../features/build-and-test/#testing-what-a-request-changed). |
| `flaky-quarantine` | Records each test's outcome with a fingerprint of the code it ran on; a test that failed and passed on the same code is flaky, and when a run's failures are known flakes the agent is told not to chase them. `/flaky` lists them. See [Flaky tests](../../features/build-and-test/#flaky-tests). |
| `repo-map` | The agent gets a `repo_map` tool: each source file's top-level declarations within a token budget, to find its way in a large codebase. See [A map of the repo](../../features/large-codebases/#a-map-of-the-repo). |
| `adr-check` | In plan and spec mode, the agent gets the architecture decisions in force (not superseded, deprecated or rejected) and checks its plan against them. See [Architecture decisions](../../features/specs/#architecture-decisions). |
| `contract-check` | At the end of a request that changed an API contract (OpenAPI, protobuf, GraphQL, Avro), the agent is told about the breaking changes it made, once per request. See [Breaking or safe](../../features/contracts/#breaking-or-safe). |
| `migration-check` | At the end of a request that wrote database migrations, the agent is told about steps that lock, need a backfill, can't be undone or break running code, once per request. See [Migration safety](../../features/contracts/#migration-safety). |
| `cache-5m` | Claude's prompt cache lives 5 minutes instead of 1 hour (the CLI's choice on a subscription): Rein starts `claude` with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`. 5-minute cache writes cost 1.25× input instead of 2×; a request more than 5 minutes after the last one writes the whole conversation again. Your own `CLAUDE_CODE_PROMPT_CACHE_TTL` wins. |
| `cheap-explore` | A main-agent `explore` tool and one line in the system prompt: questions about the codebase (where something is, how existing code works) go to a subagent on the cheapest Claude model (Haiku) with read-only tools, which reports file:line findings with short snippets. Exploring is about a third of what a large task costs before its first edit, and every file read there stays in the main model's context for the rest of the task. Claude Code sends its own Explore agent to Haiku too. |
| `compact-read` | `read` numbers lines without padding (`12` then a tab, instead of a right-aligned six-character number), about a token less per line. |
| `brief-final` | One line in the system prompt: the final reply is at most three short sentences. |
| `keep-going` | When the agent ends its turn and no other check sends it back, the [decision model](../../internals/decision-model/) reads the request and the final reply. If the agent stopped partway by its own account ("I've only partly done this", next steps it hasn't done, code that doesn't build yet) and isn't waiting on you, Rein sends it back to finish, up to 3 times per request. Runs after the code check. Models stop like this on long tasks, more often right after a compaction. |
| `price-break` | For a model billed on two rate cards by prompt size, conversations are compacted before they reach the pricier one. Haiku 5.5 costs $0.10 / $0.50 per million tokens while a request's prompt is up to 100K tokens, and $0.50 / $2.50 for the whole request above that, cache reads included. With this on, Haiku 5.5 compacts at 80K (80% of the break, leaving room for one large tool result) instead of at `autoCompactPct` of its 1M window. Measured on plain Claude Code, 85% of Haiku 5.5's requests on large tasks were over 100K. Pair it with `keep-going`: models sometimes stop after a compaction. |
| `context-cap` | Conversations are compacted at 200K tokens, or at `autoCompactPct` of the context window if that's smaller. Every request re-reads the whole conversation, and on a 1M window it otherwise grows to 300–500K tokens on large tasks, where those cache reads were about 60% of the cost. |
| `faithful-compaction` | Compaction keeps what a summary must not lose. Every request you made goes into the compacted context word for word, with the repository's state from git (`git status --short`, `git diff --stat HEAD`), both built by Rein rather than by a model. The summarizer sees up to 4,000 characters of each tool result (its start and end) instead of 300, so exact errors and test results survive. It is told to keep failed approaches and the current pass/fail state. The summary is written by the open session itself, one extra turn in which the model that did the work, with every tool result in full and its context already cached, writes it. That costs about a tenth of a separate call over the whole transcript; its tokens count in the totals. With no open session, the working model writes it in a separate call. |
| `escalate` | When the end-of-turn [code check](../../features/code-intelligence/) reported problems and the model's follow-up turn still left them, the task moves to a stronger model: the cheapest available one in a higher cost tier, same provider first. The conversation carries over as with any model switch. It lasts for the rest of that task; your next message is routed normally. The route shows `(escalated: …)`. |

