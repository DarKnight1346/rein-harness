---
title: Architecture
description: How Rein is put together, from the Ink UI through the session engine, router, decision model and account pool down to the official claude and codex CLIs, plus where every piece lives in src/.
---

Rein is a TypeScript process that holds the conversation itself and treats the official CLIs as interchangeable workers. It routes each message to a model, picks an account, drives `claude` or `codex` as a child process, and runs every tool call in its own process. That's why approvals, rewind, permissions and the transcript work the same whatever model is answering.

## The big picture

```text
┌──────────────────────── Ink UI ─────────────────────────┐
│ ui/fullscreen/FullscreenApp.tsx · ui/ClassicApp.tsx     │   or headless.ts (rein -p)
│ ui/useRein.ts (commands, queueing, windows)             │
└───────────────┬─────────────────────────────────────────┘
                │ send(text) / EngineEvent stream
┌───────────────▼────────────────────────────┐
│ Session engine        session/engine.ts    │  Rein transcript = source of truth
│  route → pickAccount → prepare (carry)     │  ~/.rein/sessions/<id>.jsonl
│  → stream → failover / compaction          │
└──┬─────────────┬──────────────┬────────────┘
   │             │              │
   │   ┌─────────▼─────────┐  ┌─▼─────────────────────┐
   │   │ Router            │  │ Compactor / carry     │
   │   │ router/index.ts   │  │ session/compactor.ts  │
   │   │ router/auto.ts    │  │ session/carry.ts      │
   │   └─────────┬─────────┘  └───────────────────────┘
   │             │ questions (never the transcript)
   │   ┌─────────▼─────────────────────────────────────┐
   │   │ Decision model   decider/index.ts             │◀── Runtime: approvals, plan-mode
   │   │  Jev (decider/jev.ts) | strict LLM (llm.ts)   │    shell checks, effort, subagent
   │   └───────────────────────────────────────────────┘    completion · GoalManager · decide tool
   │
┌──▼──────────────────────────────────────────────┐
│ Account pool                                     │
│  router/catalog.ts  ModelCatalog: models→accounts│  healthy · score · busy · retired
│  store/usage.ts     UsageStore: windows, cooldown│  ~/.rein/state/usage.json
│  Engine.pickAccount: balanced / sticky           │
└──┬──────────────────────────────┬────────────────┘
┌──▼────────────────────┐  ┌──────▼─────────────────────┐
│ providers/claude/     │  │ providers/codex/           │   ProviderAdapter
│ one `claude -p`       │  │ one `codex app-server`     │   (providers/types.ts)
│ stream-json process   │  │ per account, JSON-RPC      │
│ per conversation      │  │ thread per conversation    │
└──┬────────────────────┘  └──────┬─────────────────────┘
   │ MCP stdio                    │ item/tool/call (dynamic tools)
┌──▼─────────────────┐            │
│ tools/mcpProxy.ts  │            │
│ (thin forwarder)   │            │
└──┬─────────────────┘            │
   │ unix socket / named pipe     │ in-process
┌──▼──────────────────────────────▼─────────────────────┐
│ ToolHost  tools/host.ts                                │
│  rules → hooks → plan mode → outside paths → approval  │
│  → checkpoint → run → PostToolUse → activity event     │
└────────────────────────────────────────────────────────┘
```

Two things the original design sketch in PLAN.md didn't have, and the code does:

- **There's no separate "account pool" module.** The pool is three cooperating pieces: `ModelCatalog` in `src/router/catalog.ts` (which accounts offer which model, which are healthy, a live-session count per account, retired accounts), `UsageStore` in `src/store/usage.ts` (usage windows and cooldowns), and `Engine.pickAccount` in `src/session/engine.ts` (the balancing policy). See [Load balancing](../load-balancing/).
- **The decision model is a shared service**, not a box under the router. `decide()` in `src/decider/index.ts` is called by the auto router, by `Runtime` (auto approvals, plan-mode read-only checks, auto effort, subagent completion checks), by `GoalManager` (goal and milestone verification, gave-up detection) and by the model-facing `decide` tool. See [Decision model](../decision-model/).

## Startup

`src/cli.tsx` parses flags. `--update` runs the updater and exits. `-p`/`--print` hands off to `src/headless.ts`. Without a TTY it refuses to start. Otherwise it renders `FullscreenApp` (alt screen, mouse via `MouseStdin`) or `ClassicApp` (inline `<Static>` output) with Ink at `maxFps: 30` and `incrementalRendering`. `/tui` exits the render loop with `switchTo` and the loop re-renders the other UI with the same session id, so switching renderers keeps the conversation.

Both UIs share `src/ui/useRein.ts`, and everything stateful lives on one object: the `Runtime` singleton in `src/runtime.ts`. It owns:

| Field | Class | File |
| --- | --- | --- |
| `engine` | `Engine` | `src/session/engine.ts` |
| `tools` | `ToolHost` | `src/tools/host.ts` |
| `mcp` | `McpManager` | `src/mcp/manager.ts` |
| `agents` | `SubagentManager` | `src/agents/manager.ts` |
| `goals` | `GoalManager` | `src/goals/manager.ts` |
| `checkpoints` | `Checkpoints` (per-file, for `/rewind`) | `src/session/checkpoints.ts` |
| `snapshots` | `TreeSnapshots` (whole tree, private git store) | `src/session/snapshots.ts` |
| `auto` | the auto router | `src/router/auto.ts` |

`Runtime.init()` registers the non-file tools (agents, advisor, goals, web, skill, memory, ask_user, present_plan, decide, MCP management, todo_write, image_generate), loads `config.json`, runs `SessionStart` hooks, starts MCP servers in the background, starts the usage refresher, and builds the `Engine` with its dependencies injected (`route`, `alternative`, `compact`, `selectCarry`, `pickEffort`, `beforePrompt`, tool bindings).

## The session engine

`Engine.send()` is one turn, start to finish:

1. Run `UserPromptSubmit` hooks via `beforePrompt` (and snapshot the project for `/rewind` first). Push the user message onto the transcript.
2. **Route.** `router/index.ts` returns the pinned model, the default, or asks the auto router.
3. **Up to 5 attempts** (`MAX_ATTEMPTS`):
   - `pickAccount()` chooses an account for that model (balanced or sticky). If the model has none left, `alternative()` picks another model: the auto router again in auto mode, otherwise the healthy model closest in cost tier.
   - `effortFor()` decides the effort level. `prepare()` reuses the live native session if it belongs to the same provider and account, otherwise it opens one: resumed if the native session has seen everything so far (`coversUpTo === userIndex`), else new and seeded with an `<earlier_conversation>` carry. See [Context](../context/).
   - Stream events: text deltas, token counts, and tool activity interleaved from the `ToolHost` in arrival order.
   - On `limit`, `auth` or `overloaded`: put the account on cooldown (until its reset, or 15 minutes), exclude it, discard the partial reply and retry. On `context`: compact once and retry.
4. On `done`: save the assistant message with its tool calls (each result clipped to 4,000 characters), record `coversUpTo` for that native session, learn the model's context window from the provider, and auto-compact if the context crossed `autoCompactPct`.

The transcript (`src/session/transcript.ts`) is append-only JSONL. Native sessions are caches keyed `provider:accountId` under `transcript.native`. Lose one and Rein rebuilds the context from the transcript. That one decision is what makes cross-provider model switches, account failover and load balancing possible without the user noticing.

## Provider adapters

Both providers implement `ProviderAdapter` (`src/providers/types.ts`):

```ts
interface ProviderAdapter extends ProviderAuth {
  listModels(account): Promise<ModelInfo[]>;
  readUsage(account): Promise<UsageSnapshot | undefined>;   // free reading if available
  refreshUsage(account): Promise<UsageSnapshot | undefined>; // may cost a tiny request
  openSession(opts): Promise<ProviderSession>;
  fork(opts): Promise<ProviderSession>;                      // /btw and fork subagents
  oneShot(opts): Promise<string>;                            // decider, compactor, web, advisor
  version(); update(); shutdown();
}
```

A `ProviderSession` is one native conversation: `send(text, images)` yields `ChatEvent`s, plus `interrupt()`, `setModel()`, `nativeId()`, `close()` and an optional `setEffort()` (Codex only, since its effort is per turn). Nothing above this interface knows whether it's talking to `claude` or `codex`. The details are on the [Drivers](../drivers/) page.

Models aren't hardcoded. Claude models come from the CLI's own `initialize` control request, Codex models from `model/list`. The catalog merges them into refs like `claude:sonnet` or `codex:gpt-5.5` and keeps a list of accounts per model. Cost tiers 1–6 are inferred from each model's own description in `src/providers/tier.ts` (words like "fastest" or "frontier"), because neither CLI exposes prices.

## The tool host

Every tool runs inside the Rein process, in `ToolHost.call()` (`src/tools/host.ts`). That gives one place for permissions, approvals, checkpoints, hooks and the transcript's tool lines, whichever provider made the call. The two ways in:

- **Claude.** `claude` is started with `--strict-mcp-config --mcp-config` naming one MCP server, `rein`, whose command is `dist/tools/mcpProxy.js`. The proxy is a dependency-free stdio MCP server that forwards `tools/list` and `tools/call` as newline JSON over `REIN_TOOL_SOCKET`, a unix socket in the temp dir (a named pipe on Windows, `ipcPath()` in `src/util/platform.ts`). The model sees the tools as `mcp__rein__<name>`.
- **Codex.** Tools are passed as `dynamicTools` on `thread/start`. Codex sends a server→client `item/tool/call` request. `declineServerRequest` in `src/providers/codex/adapter.ts` looks up the thread's binding in `toolsByThread` and calls `ToolHost.call()` directly.

The host serves several sockets. The main agent has one. Each Claude subagent gets its own socket (`listenFor(origin)`) so its calls are tagged with an `origin` and stay out of the main transcript. `/btw` forks get a read-only socket (`listenReadOnly()`) that runs only non-mutating, non-main-only tools, with no approvals and no transcript activity.

MCP servers you configure are a dynamic tool source (`addSource`). When their tool list changes, `engine.refreshTools()` drops the idle native session and the next turn resumes it with the new tool list. The full pipeline inside `call()` is described in [Permissions](../../features/permissions/) and the [tools reference](../../reference/tools/).

## Repo layout

```text
src/
  cli.tsx            entry: flags, renderer loop, --update, -p
  headless.ts        rein -p: one prompt, text/json/stream-json output
  runtime.ts         Runtime singleton: wires engine, tools, agents, goals, MCP
  hooks.ts           Claude Code-compatible hooks (5 events)
  accounts/          account service (add/remove), usage collection + background refresh
  agents/            subagents (manager.ts), agent/agent_result tools, advisor
  commands/          slash-command table, /update + self-update
  decider/           decide(): Jev backend, strict-LLM backend, decide tool
  goals/             /goal loop, goal_done / milestone_done verification
  mcp/               MCP client: config sources, connections, mcp_* tools
  plans/             saved plans in .rein/plans/
  providers/         ProviderAdapter + claude/ and codex/ drivers, env hygiene, tiers
  router/            catalog (models × accounts, scores), fixed/auto routing
  session/           engine, transcript, carry, compactor, /context, /btw, checkpoints
  skills/            skill discovery and the skill tool
  store/             config.json, accounts.json, usage store, secrets, paths
  tools/             registry, ToolHost, fs/shell/web/image/memory/todo/plan/ask tools,
                     permissions, MCP proxy
  ui/                Ink components; fullscreen/ (alt-screen app), terminal/ (mouse, clipboard)
  util/              process helpers, cross-platform spawn, IPC paths, Git Bash lookup
skills/              built-in skills (plan, plan:deep, skill:create, skill:edit)
```

## Where to start contributing

- **A new tool:** add a `ToolDef` to `src/tools/registry.ts` (or register it in `Runtime.init()`). Set `mutating` honestly and it gets approvals, rules, hooks and checkpoints for free. Add `paths()` so outside-folder access gets checked.
- **A new provider:** implement `ProviderAdapter`. The engine, router, catalog and carry need no changes. PLAN.md lists Cursor, Antigravity and Grok as candidates.
- **Routing or balancing tweaks:** everything numeric is a named constant: `BALANCE_MARGIN`, `CACHE_WARM_MS`, `DANGER_HEADROOM`, `BUSY_PENALTY`, `CARRY_BUDGET_TOKENS`.

## Related

- [Drivers](../drivers/): exactly how `claude` and `codex` are driven
- [Load balancing](../load-balancing/): account choice and the balance score
- [Context](../context/): native sessions as caches, carry and compaction
- [Decision model](../decision-model/): every judgment Rein delegates
- [Tools reference](../../reference/tools/)
