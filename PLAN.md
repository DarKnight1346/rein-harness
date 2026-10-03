# Rein — v1 Plan

> Status: **v1 implemented** · 2026-10-02 · M0–M7 built and verified (§8–§11) · open: 2nd-Claude-account isolation, Jev live call

Rein is a terminal chat harness that looks and feels like Claude Code, but drives
**multiple subscription accounts across providers** through their **official CLIs**.
A decision model (Jev, or a cheap signed-in LLM) routes work; a compaction model keeps
context small.

---

## 1. Scope

### v1 (this plan)
- Providers: **Claude Code** (1+ accounts) and **Codex** (1+ ChatGPT accounts).
- Decision model: **Jev** (API key) or a signed-in LLM with strict prompts.
- Basic chat only — **no built-in tools** from either CLI. Our own tool layer is
  plumbed but ships empty (tools are a later milestone).
- 100% CLI (TypeScript + Ink), **no flicker**.

### Later
- Providers: Cursor, Antigravity, Grok.
- Our own tool suite (files, shell, web, …) exposed to every provider.
- Routing-decision logging + threshold tuning.

### Non-goals / hard rules
- Never extract or reuse OAuth tokens outside the official CLIs. All model traffic goes
  through `claude` / `codex` binaries. (Jev is a normal API key.)
- Never pass `--bare` to Claude (it refuses subscription OAuth).

---

## 2. Commands

| Command | Behavior |
|---|---|
| `/login` | Lists signed-in accounts (provider · email · plan · status). Add: Claude account, Codex account, Jev API key. Remove/re-auth an account. |
| `/usage` | Per account: **5-hour** and **weekly** used % with reset times (absolute + relative). Jev: key status. |
| `/model` | Three selections in one screen: **Chat model** (`auto` or a specific model), **Decision model**, **Compaction model**. |
| `/compact` | Summarize the conversation now with the compaction model. |
| `/update` | `claude update`, `codex update`, then Rein self-update. Shows versions before → after. |
| `/clear`, `/exit`, `/help` | Basics. |

### `/model` screen
```
Chat model:        ● auto  (Jev decides per task)
                   ○ opus · sonnet · haiku            (Claude)
                   ○ gpt-5.5 · gpt-5.4-mini · …       (Codex)

Decision model:    ● Jev                    (if key set; falls back below on error)
                   ● cheapest available     ← default without Jev
                   ○ any signed-in model

Compaction model:  ● cheapest available     ← default
                   ○ any signed-in model
```
- "Cheapest available" = fixed cost-tier ranking (small/fast models first: Claude Haiku,
  Codex `*-mini`; flagships last), restricted to models with a healthy account; ties
  broken by most remaining headroom. Re-resolves automatically when accounts become
  exhausted or are removed. An explicit user pick stays pinned.
- Model lists: Claude = known aliases (no CLI list command); Codex = `model/list` from app-server.

---

## 3. Architecture

```
┌──────────────── Ink UI (no-flicker renderer) ────────────────┐
│ <Static> transcript · live streaming row · input · status bar │
└──────────────┬────────────────────────────────────────────────┘
               │ events
       ┌───────▼─────────┐     ┌─────────────┐   ┌─────────────┐
       │ Session         │────▶│ Router      │──▶│ Decider     │
       │ (Rein transcript│     │ (auto mode) │   │ Jev | LLM   │
       │  = source of    │     └─────────────┘   └─────────────┘
       │  truth)         │────▶ Compactor (any model)
       └───────┬─────────┘
       ┌───────▼─────────┐  model → healthy account w/ most headroom
       │ Account pool    │  tracks 5h/weekly %, cooldowns, failover
       └───┬─────────┬───┘
   ┌───────▼───┐ ┌───▼──────────┐
   │ Claude    │ │ Codex        │   ProviderAdapter interface
   │ adapter   │ │ adapter      │
   └───────────┘ └──────────────┘
```

### 3.1 ProviderAdapter interface (sketch)
```ts
interface ProviderAdapter {
  id: 'claude' | 'codex';
  listAccounts(): Promise<AccountInfo[]>;            // email, plan, loggedIn
  login(account: AccountRef): AsyncIterable<LoginEvent>;
  logout(account: AccountRef): Promise<void>;
  listModels(account: AccountRef): Promise<ModelInfo[]>;
  usage(account: AccountRef): Promise<UsageSnapshot>; // 5h + weekly, resetsAt
  openSession(opts: SessionOpts): Promise<ProviderSession>;
  update(): AsyncIterable<UpdateEvent>;
  version(): Promise<string>;
}
interface ProviderSession {
  send(text: string): AsyncIterable<ChatEvent>;     // text deltas, done, error(limit|other)
  setModel(model: string): Promise<void>;
  nativeId(): string | undefined;                     // for resume
  close(): Promise<void>;
}
type UsageSnapshot = {
  fiveHour?: { usedPct: number; resetsAt: Date };
  weekly?:   { usedPct: number; resetsAt: Date };
  source: 'live' | 'cached' | 'from-limit-error' | 'unknown';
};
```

### 3.2 Claude adapter
- **Isolation:** one `CLAUDE_CONFIG_DIR` per account under `~/.rein/accounts/claude/<id>/`
  (keychain entry is keyed per config dir on macOS).
- **Login:** `claude auth login` with that env; verify via `claude auth status --json`
  (`loggedIn`, `email`, `subscriptionType`).
- **Chat:** one long-lived process per conversation:
  `claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --system-prompt-file <rein prompt> --tools ""
  --strict-mcp-config --mcp-config <rein tools | {"mcpServers":{}}> --setting-sources ""
  --model <m>` (verified in M0; `--strict-mcp-config` is required or claude.ai connectors leak in).
- **Model switch:** `set_model` control request on the live process (no restart; verified §10).
- **Usage:** `rate_limit_event` in stream-json carries
  `unifiedWindows.five_hour/seven_day.{utilization, resetsAt}` — verified in M0. It fires on the
  **first request of a process only** (3-turn run → 1 event; possibly again when status changes),
  so a long-lived chat's snapshot goes stale; `/usage` refresh = spawn a fresh short-lived
  process with a tiny haiku ping.
- **Resume vs. no-persistence (decide in M2):** `--resume` (model switch) needs a persisted
  session; `--no-session-persistence` (history-pollution mitigation, §3.4) prevents that.
  Likely: persist always; accept the history side effect for imported default accounts.
- **Env hygiene:** strip `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` from the child env so
  the account's own login is always used.

### 3.3 Codex adapter
- **Isolation:** one `CODEX_HOME` per account under `~/.rein/accounts/codex/<id>/`.
- **Transport:** `codex app-server` (JSON-RPC over stdio), one process per account.
  `initialize` → `initialized`.
- **Login:** `account/login/start {type:"chatgpt"}` → open `authUrl`; device-code variant
  available. Completion via `account/login/completed`. Info via `account/read`.
- **Chat:** `thread/start {model, baseInstructions, personality:"none", ephemeral?}` →
  `turn/start {threadId, input, model, effort}`; stream `item/agentMessage/delta`;
  done on `turn/completed`.
- **Model switch:** per-turn `model` on `turn/start` (no restart).
- **Usage:** `account/rateLimits/read` + `account/rateLimits/updated` notifications.
  Map windows by `windowDurationMins` (≈300 → 5h, ≈10080 → weekly), not by
  primary/secondary position.
- **Limit errors:** `error.codexErrorInfo == "usageLimitExceeded"` → cooldown until reset.
- **No built-in tools:** `--disable` tool features + `web_search="disabled"` **and** a Rein
  model catalog (`model_catalog_json`) that nulls `tool_mode`/`apply_patch_tool_type`/`shell_type`
  (see §8). Verify from a `RUST_LOG=trace` request capture, not `codex debug prompt-input`.
- **Env hygiene:** strip `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`.
- **Protocol drift:** app-server is experimental. Generate TS types with
  `codex app-server generate-ts` at build time; at runtime check `codex --version` against a
  tested range and warn on mismatch.

### 3.4 Importing existing logins
- On first run, detect `~/.claude` (`claude auth status --json`) and `~/.codex`
  (app-server `account/read`) and offer to register them as accounts **in place**
  (Rein points at the existing dir; credentials are not copied).
- **Default dirs = inherit env, never set the var.** `CLAUDE_CONFIG_DIR=~/.claude` explicitly
  shows logged-out (different config-file path + keychain key). Imported default accounts run
  with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` unset.
- Codex login truth = app-server `account/read`; `codex login status` says "Logged in" even
  when the refresh token is dead.
- Side effect to accept: Rein's sessions for those accounts appear in that CLI's normal
  history. (Mitigation: ephemeral/no-persistence where supported.)

### 3.5 Account pool & failover
- State per account: `healthy | cooling(until) | error | loggedOut`, last usage snapshot.
- Pick: requested model → accounts for that provider → exclude cooling/≥ threshold →
  most headroom (min of 5h/weekly remaining).
- On limit error: mark cooling until `resetsAt` (or parsed reset time, or default), retry
  on next account of same provider; if none: in auto mode the auto router re-decides among the
  remaining models, otherwise the healthy model closest in cost tier is used (no tokens); carry
  context via verbatim recent turns or the Compactor summary (§3.8).
- All numeric comparisons happen in code (never asked of Jev).

### 3.6 Decider (`ask(state, questions)` → typed answers)
Same interface for both backends; questions are `choice | noul | score` (Jev's schema).

**Jev backend:** `POST https://api.typesafe.ai/v1/systemone`, Bearer key, pinned versioned
model ID (e.g. `jev-1.13.0`) so thresholds stay calibrated. Retry 429/529 with backoff;
timeout → fallback backend.

**LLM backend:** same questions rendered into a compact strict prompt; output constrained to a
tiny JSON object; validate; one retry; then default.

### 3.7 `/model auto` — token-efficient routing
1. **Pre-filter in code:** drop models with no healthy account. One candidate → no call.
2. **One call, ≤2 questions:**
   - `switch` (noul, mid-conversation only): "Does this message start a materially
     different kind of task than the current one?"
   - `model` (choice): candidates with short **fixed** capability descriptions.
3. **Minimal state:** new message (head+tail, ~1–2k tokens max), current model, one-line
   task tag, turn count. **Never the transcript.**
4. **Sticky:** stay on the current model unless `switch` ≥ ~0.7 → keeps native session warm,
   avoids re-sending context. First message asks only `model`.
5. **Confidence gate:** low `model` confidence → user's default model.
6. **Order-bias guard:** shuffle choice options every call.
7. **Visible:** `→ sonnet (auto · 0.86)` line under the reply.

### 3.8 Compactor
- Rein keeps its own transcript; native sessions are disposable caches.
- Triggers: `/compact`, nearing the active model's context window, provider/account
  failover, and chat-model switch across providers.
- Produces a structured summary; new native session is seeded with it.

### 3.9 `/update`
1. Show current versions (`claude --version`, `codex --version`, Rein).
2. Run `claude update`, then `codex update`, streaming output; if a command is missing or
   fails, print the manual command instead of guessing.
3. Restart live sessions (Claude: `--resume`; Codex: restart app-server + `thread/resume`).
4. Codex: re-check protocol compatibility; warn on breaking drift.
5. Rein self-update last (npm global); prompt to restart if needed.
6. Optional: quiet "updates available" hint in the status bar on startup.

---

## 4. No-flicker UI (Ink)

Flicker in Ink comes from re-rendering large dynamic regions and from the dynamic region
exceeding terminal height (forcing full clears). Rules:
- Finished messages go in `<Static>` — rendered once, never re-rendered.
- The dynamic region is tiny: current streaming message + input + status bar.
- Stream deltas are **batched** (flush ~every 16–33 ms), never a render per token.
- Cap the live streaming block's height (**~12 wrapped rows**, measured in terminal rows, not `\n`s); when a block grows past the viewport, commit the
  completed lines to `<Static>` and keep only the tail live.
- No full-screen clears; no spinners that re-layout; avoid width-dependent re-wrap churn.
- M0 spike measures this with a fast fake stream before any real backend work. If stock Ink
  can't meet the bar, fall back to a patched/differential renderer.

---

## 5. Files & config

```
~/.rein/
  config.json          # chat/decision/compaction model picks, thresholds
  accounts.json        # registry: id, provider, home dir, imported?, label
  accounts/claude/<id>/   # CLAUDE_CONFIG_DIR
  accounts/codex/<id>/    # CODEX_HOME
  state/usage.json     # last-known usage snapshots
  sessions/            # Rein transcripts
  secrets              # Jev key → macOS Keychain (fallback: 0600 file)
```

Repo layout (proposed):
```
rein-harness/
  src/
    cli.tsx              # entry, arg parsing
    ui/                  # Ink components, renderer rules
    commands/            # login, usage, model, compact, update
    session/             # transcript, compactor
    router/              # auto routing, account pool
    decider/             # jev.ts, llm.ts, types.ts
    providers/claude/    # adapter, stream-json parser
    providers/codex/     # adapter, app-server client, generated types
    tools/               # Rein MCP tool server (empty in v1)
  test/
  PLAN.md
```
Stack: Node ≥ 20, TypeScript, Ink, `@typesafe-ai/sdk` (or raw fetch), vitest.

---

## 6. Open risks

| Risk | Plan |
|---|---|
| ~~Claude 5h/weekly usage headlessly.~~ **Resolved in M0:** `rate_limit_event` in stream-json. | Emitted once per process, so cached snapshots go stale; `/usage` shows cached values with age and refreshes via a fresh short-lived haiku ping. |
| Claude usage-limit error shape in stream-json is undocumented. | Capture in M0; parse reset time defensively. |
| Codex app-server is experimental; Codex auto-updated mid-research (0.133 → 0.160). | Generated types, version range check, `/update` compatibility check. |
| Fully disabling Codex built-in tools. | Verify via `codex debug prompt-input` in M0. |
| Ink flicker. | §4 rules + M0 spike. |
| Jev access may be waitlisted; error body format undocumented. | LLM decider fallback always available. |
| Provider ToS: multiple accounts per provider. | User's choice; Rein uses only official CLIs. |

---

## 7. Milestones

| # | Deliverable | Done when |
|---|---|---|
| **M0** | Spikes | Recorded real Claude stream-json (incl. limit/usage events); Codex app-server handshake, `account/read`, `rateLimits/read`, `model/list`, tools-disabled prompt verified; isolated logins work for both; Ink no-flicker spike passes with a 200 tok/s fake stream. Findings appended here. |
| **M1** | Skeleton | `rein` launches Ink UI; config + account registry; import existing logins; `/login` list/add/remove for Claude & Codex. |
| **M2** | Claude chat | Streaming chat via Claude adapter, no tools, custom system prompt; resume. |
| **M3** | Codex chat + `/model` | Codex adapter; `/model` screen (chat/decision/compaction); manual model switching across providers. |
| **M4** | `/usage` | 5h + weekly with resets for all accounts; status-bar summary. |
| **M5** | Decider + auto + failover | Jev + LLM backends; `/model auto`; limit-triggered failover. |
| **M6** | Compactor | `/compact`, auto-compact, cross-provider context carry. |
| **M7** | `/update` | CLI + self update, session restart, Codex compat check. |

---

## 8. M0 findings (2026-10-02)

Spike scripts + raw captures live in `spikes/` (`spikes/out/`).

**Claude (2.1.288, `~/.claude`, Max plan)**
- ✅ One `claude -p --input-format stream-json` process handles multiple turns with memory
  (two user lines on stdin → two `result` events, same `session_id`).
- ✅ Event types seen: `system/init`, `system/status`, `system/thinking_tokens`,
  `stream_event/{message_start, content_block_start|delta|stop, message_delta, message_stop}`,
  `assistant`, `rate_limit_event`, `result/success`.
- ✅ **Usage headlessly** (one event per process — 3-turn run emitted 1): `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
  "resetsAt":…,"rateLimitType":"five_hour","overageStatus":…,"isUsingOverage":false,
  "unifiedWindows":{"five_hour":{"utilization":0.01,"resetsAt":…},"seven_day":{"utilization":0,
  "resetsAt":…}}}}`. `resetsAt` is unix seconds, utilization is 0–1.
- ✅ `--tools ""` + `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` → `tools: []`.
  Without strict MCP, the account's claude.ai connectors (Docs, Gmail, …) are injected.
  Skills/agents are still *listed* in init, but with no Skill/Agent tool they're inert.
- ✅ `--setting-sources ""` does not break subscription auth.
- ❌ `CLAUDE_CONFIG_DIR=$HOME/.claude` → logged out. Imported default account must leave it unset.
- ⏳ Limit-hit error shape not captured (can't trigger on demand). `rate_limit_event.status`
  ≠ `allowed` is the early signal; parse result-error text defensively.

**Codex (0.160.0)**
- ✅ `codex app-server generate-ts --out <dir>` works (≈640 v2 types). `ThreadStartParams`
  has `baseInstructions`, `developerInstructions`, `config`, `ephemeral`, `sandbox`, `approvalPolicy`.
- ✅ Handshake + `account/read` work. `account/read` correctly reports `account: null` for the
  existing `~/.codex` login, whose refresh token is dead (last refresh 2026-05-23);
  `codex login status` still claims "Logged in" → never trust it.
- ⚠ `codex debug prompt-input` shows prompt *items* (skills, permissions, collaboration mode,
  multi-agent role, environment context) but **not tool definitions** → tools-disabled check
  must be done by inspecting turn items / asking the model. Default prompt includes sections we
  should suppress: skills, collaboration_mode, multi_agent (disabled via features in the spike).
- ✅ After re-login: `account/read` → `{type:"chatgpt", email, planType:"free"}`.
- ✅ `account/rateLimits/read` on the **free** plan returns a single **30-day** window
  (`windowDurationMins: 43200`, `secondary: null`) — no 5h/weekly. `/usage` must render
  whatever windows exist, labelled by duration (5h / weekly / 30-day / …).
- ✅ `model/list` is per account/plan (free: `gpt-6-luna`*, `gpt-5.6-terra`, `gpt-5.6-luna`,
  `gpt-5.5`) with `displayName`, `description`, reasoning efforts. Unsupported models fail the
  turn with a 400 (`codexErrorInfo:"other"`) → never hardcode Codex model names.
- ✅ `thread/start` + two `turn/start`s stream `item/agentMessage/delta` and end with
  `turn/completed`; context carries across turns. ~2–5 s per short turn.
- ⚠ **Built-in tools come from the model catalog, not features.** e.g. `gpt-5.6-luna` has
  `tool_mode:"code_mode_only"`, `apply_patch_tool_type:"freeform"`, `shell_type:"unified_exec"`
  → tools `exec` (JS V8 isolate, no fs/network) + `wait` + nested `apply_patch`, regardless of
  `--disable` flags or `include_apply_patch_tool=false`.
  **Fix (verified via `RUST_LOG=trace` request capture, `spikes/codex-tools.py`):** write a Rein
  catalog derived from the account's `models_cache.json` with `tool_mode:null,
  apply_patch_tool_type:null, shell_type:"disabled", experimental_supported_tools:[]` and pass
  `-c model_catalog_json="<path>"`, plus `include_permissions_instructions=false,
  include_collaboration_mode_instructions=false, include_environment_context=false,
  include_apps_instructions=false`. Result: the only tool left is `request_user_input`
  (arrives as a server→client request; Rein answers/declines it). First-turn input ≈ 1.1k tokens.
  Model self-reports of its tools are unreliable (it hallucinated `tool_search`) — verify from the trace.
- Defense in depth: `sandbox:"read-only"`, and Rein declines every approval request.

**Ink (7.1.1, React 19)**
- Ink 7 has `incrementalRendering`, `maxFps`, and wraps frames in synchronized-update
  escapes (DEC 2026). It **full-clears the terminal whenever the dynamic region ≥ terminal rows**.
- 200 tok/s fake stream, 40×100 terminal, one 1200-token message:

  | mode | frames | bytes | full clears | max rows redrawn/frame |
  |---|---|---|---|---|
  | naive (render per token, unbounded) | 1202 | 4.2 MB | **551** | 40 |
  | rein (33 ms batch, `<Static>` commit, live cap 32 rows) | 238 | 120 KB | 0 | 38 |
  | rein, live cap 12 rows | 235 | 84 KB | **0** | 18 |
  | rein, live cap 6 rows | 246 | 66 KB | 0 | 12 |
- Height cap must count *wrapped* rows; counting `\n` still produced 110 full clears.
- User's terminal is Apple Terminal (no synchronized-output support as far as known), so a
  small live region matters. Eyeball test: `cd spikes/ink && LIVE=12 MSGS=1 npx tsx flicker.tsx rein --tty`.

**Still to do in M0**
1. ~~Codex re-login + spike~~ done.
2. Isolated fresh-dir logins: `CLAUDE_CONFIG_DIR=~/.rein/accounts/claude/<id> claude auth login`
   (second Claude account) and a fresh `CODEX_HOME` — needs the user in a browser.
   Note: `claude auth login` uses a **paste-the-code** flow (redirect to
   platform.claude.com) → Rein's `/login` must show the URL and forward a pasted code to the
   child's stdin (or use a PTY). Codex login uses a localhost:1455 callback (no paste).

---

## 9. M1 notes (2026-10-02)

Built: `src/` per §5 layout (`store/`, `accounts/`, `providers/{claude,codex}`, `ui/`, `commands/`),
16 vitest tests (fake `codex app-server` fixture), `npm run build` → `dist/cli.js` (`bin: rein`).

- **Registry** `~/.rein/accounts.json`: `{id, provider, home|null, imported, email, plan}`.
  `home: null` = CLI default dir with the env var unset. `REIN_HOME` overrides the root.
- **Import:** first run probes `~/.claude` / `~/.codex`, shows a Y/n prompt, then never asks again.
- **`/login`:** live status per account; add Claude/Codex (owned dir under
  `~/.rein/accounts/<provider>/<id>`); re-authenticate; remove. Imported accounts are only
  unregistered — never logged out; owned dirs are logged out and deleted (guarded to paths
  under `~/.rein/accounts`). Same email added twice is rejected. Jev row is a placeholder (M5).
- **Claude add flow:** URL + masked paste-code field forwarded to `claude auth login` stdin.
  ⚠ Completion untested end-to-end (needs the second account).
- **Codex add flow:** `account/login/start` → open `authUrl` → `account/login/completed`.
  Verified against the real CLI up to the browser step on a fresh `CODEX_HOME`.
- **Codex isolation:** two concurrent app-servers (default + fresh `CODEX_HOME`) each see only
  their own login — no cross-talk via the app-server daemon.
- **UI:** `<Static>` transcript, small live region, `maxFps: 30`, `incrementalRendering`.
  PTY-driven run (import → /help → text → /login → menus → /exit): 0 full clears.
  Pasted text containing newlines does not submit (newlines become spaces).
- Env vars for testing: `REIN_HOME`, `REIN_CLAUDE_BIN`, `REIN_CODEX_BIN`, `REIN_NO_BROWSER`.
- PTY drive also covered: add Codex → URL shown → Esc cancels and deletes `codex-1`; remove an
  imported account → unregistered while the real `~/.codex` login stays intact; `/clear`
  (remounts `<Static>` so the banner re-renders).
- `config.json` landed with `/model` (M3). ✅ "Re-authenticate" on an imported account now asks y/n first.

---

## 10. M2–M7 build notes (2026-10-02)

New protocol facts (spikes/out/claude-control.jsonl):
- Claude stream-json accepts control requests on stdin:
  `{"type":"control_request","request_id":"r1","request":{"subtype":"set_model","model":"sonnet"}}`
  → switches model **in-process** (next `system/init` shows the new model; no `--resume` restart), and
  `{"subtype":"interrupt"}` → current turn ends with `result/error_during_execution`; the process
  keeps serving later turns. Model switch within a provider/account is therefore free.
- Codex: `turn/interrupt {threadId, turnId}`, `thread/resume {threadId, model?, baseInstructions?…}`,
  approval responses `{decision:"decline"}`, user-input response `{answers:{}}`; errors arrive as
  `error {error:{message, codexErrorInfo}, willRetry}`; `codexErrorInfo` includes
  `usageLimitExceeded | rateLimitExceeded | contextWindowExceeded | serverOverloaded | …`.
  Model catalog (`models_cache.json`) has `context_window` per model.
- Jev (SDK 0.6.0 types): `POST /v1/systemone` `{state, questions, model}` → `{model, answers, usage}`;
  `GET /v1/models`. noul `criteria:{true,false}` → `{noul: p}`; choice `criteria:{label: desc}` →
  `{choice, confidence, probabilities}`; score `criteria:[d0,d1,…]` → `{score, confidence}`.

Design decisions:
- `UsageSnapshot` = list of windows `{usedPct, resetsAt, windowMins}` (Codex free = one 30-day
  window), labelled by duration. Stored in `~/.rein/state/usage.json`, fed by session events.
- Rein transcript is the source of truth (`~/.rein/sessions/<id>.json`). A native session is
  reused while provider+account stay the same (model changes via `set_model` / per-turn model).
  Any other change opens a new native session seeded with a *context carry*: verbatim recent
  turns if small, else compactor summary + recent turns.
- Claude sessions persist (needed for `rein --continue` resume); one-shot calls (decider,
  compactor, usage ping) use `--no-session-persistence`.
- Codex: one long-lived app-server per account; tools stripped via the Rein catalog; every
  server→client request is declined.

---

## 11. M2–M7 implementation notes (2026-10-02)

| # | Status | Verified by |
|---|---|---|
| M2 Claude chat | ✅ | PTY: stream on haiku, Esc interrupt → `interrupted` (not error), follow-up in the same native session remembers context; 0 full clears. `rein --continue` after restart resumes the **same native session** (Claude `--resume`, Codex `thread/resume`; same id before/after, recalls earlier turn). |
| M3 Codex chat + `/model` | ✅ | PTY: Codex chat (gpt-6-luna) with context; `/model` tabs; `/model gpt-6-luna` mid-conversation → Codex answers from carried Claude context. Trace capture: only `request_user_input` left (see below). |
| M4 `/usage` | ✅ | PTY: Claude 5h + weekly, Codex 30-day, bars + reset times; printed into the transcript (no overlay height risk). |
| M5 Decider + auto + failover | ✅ (Jev mocked) | Live: LLM decider (haiku, thinking off) ~1.5 s/decision; "2+2" → haiku 0.99, lock-free queue design → opus 0.92, trivial follow-up → sticky. Unit: Jev request/retry/401 against a local mock server; failover (limit → next account with carry; all limited → other provider); confidence gate; single candidate = no call. |
| M6 Compactor | ✅ | PTY: `/compact` → summary by cheapest model; next turn + `--continue` restart answer from summary + recent turns. Unit: chunked folding, native refs dropped. |
| M7 `/update` | ✅ (fake CLIs) | Unit with fake `claude`/`codex`: versions before/after, streamed output, Codex protocol smoke check, out-of-range warning, self-update message. Not run against the real CLIs (would upgrade them). |

Findings during the build:
- **Codex `gpt-6-luna` injects multi-agent tools** (`spawn_agent`, `send_message`, `wait_agent`, …)
  from `multi_agent_version: "v2"` in the catalog, even with the `multi_agent` feature off. The Rein
  catalog now also nulls `multi_agent_version` and sets `node_repl_disabled`. Verified on gpt-6-luna
  and gpt-5.6-terra: tools = `[request_user_input]`, first-turn input 763 tokens.
  Re-verify after Codex updates: `cd spikes && npx tsx verify-codex-tools.mts <model> && python3 codex-tools.py`.
- `MAX_THINKING_TOKENS=0` cuts a haiku decision from ~4 s to ~1 s API time; decider one-shots use it
  (`fast`), Codex decider turns use `effort: "low"`.
- After compaction the native session refs are dropped; otherwise `--resume` would reload the full
  history and defeat the compaction.
- Engine records a cooldown on any limit error itself (adapters also do), so the pool never retries
  an exhausted account before its reset.
- Default chat model when unset: Claude Sonnet if a Claude account exists, else Codex's default.
- Decision/compaction "cheapest available" ties break by headroom, then provider order.

Known gaps / follow-ups:
- **Tool layer (§1 "plumbed but ships empty", §5 `src/tools/`) is not built** — v1 ships with no
  tools at all rather than an empty framework. Starting points: Claude `--mcp-config` (Rein MCP
  server) + allowlist; Codex dynamic tools (`DynamicToolNamespaceSpec`, server→client
  `item/tool/call`, currently declined in `codex/adapter.ts`).
- `/update` runs the real updaters (no dry-run flag in `codex update`); Ctrl+C aborts. Commands have
  no timeout.
- Second Claude account: add flow (paste-code) and dual-account isolation untested — needs the
  user's second login.
- Jev: never called live (no key yet); request shape follows SDK 0.6.0 types.
- Real Claude limit-hit payload still unseen; parsing is defensive (`status != allowed`, result
  text with "resets 3:45pm").
- No Markdown rendering; replies render as plain text. Input is disabled while a reply streams.
- Optional startup "updates available" hint (§3.9 step 6) not built.

---

## 12. Fullscreen TUI (2026-10-02, built — default renderer)

Goal (user): app-like layout — status line at the top, chat history filling the middle, input at
the bottom, a sidebar for future panels (subagents, …), and **mouse clicks** on UI elements
(tabs, autocomplete items, model options, sidebar entries). Mirrors Claude Code's "fullscreen"
renderer (`/tui fullscreen`, `CLAUDE_CODE_NO_FLICKER=1`: "flicker-free alt-screen renderer with
virtualized scrollback"; the binary also toggles mouse modes 1000/1006/1007 and 2026 sync output).

```
┌ ◐ Rein · Sonnet (auto) · me@x.com · 5h 12% · weekly 3% · ctx 4% ─────── [≡ sidebar] ┐  ← top bar (clickable segments)
│ chat history (virtualized, scrolls)                       │ Accounts               │
│ ⏺ reply …                                                 │  Claude ▮▮▯ 12%        │  ← sidebar (toggle, auto-hidden
│ > user …                                                  │ Models                 │     on narrow terminals)
│                                                           │  ● Sonnet  ○ Haiku …   │
│ ┌ autocomplete / modal panels (login, model) ┐            │ Session                │
├───────────────────────────────────────────────────────────┴────────────────────────┤
│ > input (multi-line)                                                                │  ← input
└ hints: esc interrupt · pgup/pgdn/wheel scroll · /help ─────────────────────────────┘
```

Design:
- **Alt screen** via Ink's `alternateScreen`; root box = terminal size, so resize is a full,
  correct redraw (no reflow artifacts, no scrollback damage). On exit the conversation is printed
  to the normal screen so it stays in terminal history.
- **History as lines:** every transcript entry renders to wrapped ANSI lines for the current width
  (`ui/lines.ts`); the history pane shows a window of them (follow-tail unless scrolled up). The
  classic renderer uses the same line renderers.
- **Mouse:** SGR mouse (1000+1006) enabled while running. A stdin proxy strips mouse sequences
  before Ink's parser and emits click/wheel events. `useClickable(ref, onClick)` registers Ink
  boxes; hits are resolved from Yoga layout (absolute rect = sum of computed offsets). Topmost
  (latest-registered) wins. Wheel scrolls the history.
- Tradeoff: with mouse reporting on, the terminal's own drag-to-select needs a modifier
  (Option in iTerm2/Terminal-dependent). `rein --classic` / `/tui classic` keeps the old renderer.
- `/tui fullscreen|classic` switches renderer in-process (config `tui`, default `fullscreen`).

Status / verification (PTY + headless xterm.js / pyte screen models):
- Spike: alt screen + fixed-height root + 200 tok/s stream + 110 ms spinner → the only full clear is
  at unmount; ~1 KB per frame (incremental line diffs).
- Layout renders as sketched; sidebar auto-hides below 96 cols; ctrl+b / `[≡]` toggles (persisted).
- Virtualized history: wheel (3 lines), PgUp/PgDn, End / click "↓ N lines below" to jump back;
  view stays anchored while new lines arrive when scrolled up.
- Clicks verified: top-bar model → picker; `/model` tabs + options; sidebar models (→ `/model x`),
  accounts → `/usage`, ⚙ accounts → `/login` rows, account actions, Jev actions, yes/no;
  autocomplete rows; sidebar toggle.
- **Drag to copy:** with mouse reporting on, the terminal's own selection is unavailable, so the
  history pane implements it (1002 button-motion): drag highlights (inverse), release copies via
  pbcopy (+ OSC 52), "✓ Copied N characters". Dragging past an edge scrolls.
- Resize: Ink renders one frame with stale React sizes before state updates; the layout uses flex
  (no explicit widths from state) so that frame clips instead of wrapping, and the resize hook
  wipes the alt screen so Ink repaints from scratch. Verified 110→70→110 with no fragments.
- Mouse/alt-screen modes are restored on exit, signals and crashes; on exit the transcript is
  printed to the normal screen. `/tui classic|fullscreen` switches in-process and resumes.
- Classic renderer unchanged (`--classic`, `/tui classic`): no alt screen, no mouse.
- Spinner: 4-cell bar wave (▇▅▃▁ ↔) with a rainbow flowing through bar + label.

Known gaps: no double-click word select; selection copies wrapped lines with their line breaks;
Terminal.app needs View → Allow Mouse Reporting (⌘R) on; tabs (multiple sessions) and a subagents
sidebar section are the next layout additions. `entryLines()` duplicates classic `EntryView`.
- **Windows:** in fullscreen, `/login`, `/model`, `/usage`, `/context`, `/help`, `/update` and the
  first-run import prompt open as centered windows (absolute position + own background) over
  everything; replies keep streaming underneath. Esc / `[×]` / click outside closes (Esc only
  interrupts the agent when no window is open). Windows are mouse-modal: nothing underneath is
  clickable while one is open. Long content scrolls (↑↓, PgUp/PgDn, wheel); the update log follows
  new output. Classic keeps the inline behavior. Autocomplete stays anchored above the input.
- **`/configure`** (alias `/config`): window with two tabs — status-line segments (model, account,
  usage, context, decision model, messages, sidebar button) and sidebar sections (accounts, chat
  model, context, auto routing, session, shortcuts). Toggle (click/space), reorder (▲▼ click,
  shift+↑↓ or [ ]), `r` resets. Saved to `config.json` (`statusLine`, `sidebarSections`) and applied
  live; the classic status bar uses the same segment list. Sections that don't fit the sidebar's
  height are clipped.

---

## 13. Tools, skills, AGENTS.md (2026-10-02, built)

Also done alongside: Claude context windows corrected (sonnet/opus/fable 1M, haiku 200k) and
learned at runtime from `result.modelUsage[*].contextWindow` (verified: haiku 200000, sonnet
1000000). Auto-compact threshold is configurable in `/configure` → Compaction (off, 50–95%,
default 80%).

### Tools (one implementation, both providers)
Spikes (spikes/mcp-echo.mjs, spikes/codex-dyn.mts):
- **Claude:** a Rein MCP stdio server via `--mcp-config` + `--strict-mcp-config`, with
  `--tools ""` still on (built-ins stay off) and `--allowedTools mcp__rein__<tool>,…` → init shows
  only `mcp__rein__*`; haiku called it and used the result. ✅
- **Codex:** `initialize {capabilities:{experimentalApi:true}}` + `thread/start {dynamicTools:[{type:
  "function", name, description, inputSchema}]}`; Codex sends server→client `item/tool/call
  {tool, arguments, callId}` and Rein replies `{contentItems:[{type:"inputText",text}], success}`. ✅

Design:
- `src/tools/`: `read`, `write`, `edit` (exact unique string replace, optional replace_all),
  `delete`, `search` (ripgrep if installed, JS fallback; content or file-name mode). All paths
  are confined to the project root (cwd); results are capped in size.
- **Execution lives in the Rein process** (one place for approvals + UI). Claude's MCP server is a
  thin stdio proxy (`dist/tools/mcpProxy.js`) that forwards `tools/call` over a per-session unix
  socket to Rein. Codex calls arrive in-process via `item/tool/call`.
- **Approvals:** read/search run freely; write/edit/delete ask (window: Allow once / Allow this
  session / Deny) unless `/configure` → Tools is set to auto-approve. Denials return an error
  result to the model.
- **UI:** tool calls show in the transcript as `⏺ Edit(src/x.ts)` + a one-line result.
### Skills
- `~/.rein/skills` (global) and `<cwd>/.rein/skills` (project; wins on name clash). A skill is
  `<name>/SKILL.md` or `<name>.md`, optional frontmatter `name`, `description`.
- Listed in `/` autocomplete after built-ins (built-in names win); `/skill args` sends the skill's
  instructions + args as the user turn.
### AGENTS.md
- Rein reads `AGENTS.md` from `~/.rein/AGENTS.md` (global) and from the project root up to the git
  root, and appends them to its system prompt for every provider. Codex's own project-doc loading
  is disabled (`project_doc_max_bytes=0`) to avoid duplicates; Claude already ignores it.

Status / verification:
- Tools (`src/tools/`): read · write · edit · delete · search; confined to the project root after
  realpath (symlink escapes rejected); edit requires a unique exact match (else reports the count).
  Unit-tested (13 tests). `search` uses ripgrep when it's a real binary, else a JS walk (skips
  .git/node_modules/dist; doesn't read .gitignore).
- Live: haiku (MCP proxy, also from `dist/`) and gpt-6-luna (dynamic tools) each read + edited a
  file in a temp project; tool lines show in the transcript (`⏺ Edit(hello.txt) · you approved`).
- Approvals (`/configure` → Approvals): **ask** (default; window with diff preview, Allow / Allow
  session / Deny, not dismissable by stray clicks, Esc = deny), **auto** (decision model, one noul
  call with the user's last request + action + preview; allow at ≥ 0.85, otherwise ask — never
  auto-deny; live: "auto-approved (0.95 via haiku)"), **bypass** (allow all).
- Tokens: loading line shows the current call's ↑ sent / ↓ received live (Claude: per-API-call
  usage from message_start/message_delta, summed across tool steps; Codex: summed
  `thread/tokenUsage/updated.last`). Sidebar Session shows conversation totals uncached / cached /
  received (persisted in the transcript).
- Skills: `/name` in autocomplete (tagged project/global), project overrides global, shadowed names
  warned at startup, rescanned whenever `/` is typed; live: project skill `/shout` ran.
- AGENTS.md: ~/.rein/AGENTS.md + git-root→cwd files appended to the system prompt; live: the rule
  in a temp project's AGENTS.md was followed. Codex `project_doc_max_bytes=0` confirmed accepted.
- Codex config audit: `skills.enabled` and `include_apply_patch_tool` were silently ignored by
  Codex 0.160 → removed (the catalog override already covers them).
- Sidebar bars now fill the section width.

Known gaps: no shell/exec tool; tool calls aren't stored in Rein's transcript (native sessions
keep them, a cross-provider handoff carries only the text); approvals are per-session, not
per-path rules; skills are user-invoked only (no model-invoked skill tool yet).

---

## 14. Shell, /btw, Ctrl+C, list (2026-10-02, built)

- **shell** tool (+ `shell_logs`, `shell_kill`): `$SHELL -c` in the project root (or a `cwd` inside
  it), own process group (kill reaches children), no stdin/TTY, `CI=1`, ANSI stripped, `\r`
  progress collapsed, 5000-line buffer. Same approval flow as file changes (ask / auto judge with a
  command-specific question / bypass). Foreground: default 2 min timeout, the agent may ask for more
  up to the user's cap (`/configure` → Shell, default **120 min**, or no limit); output (tail ≤30k
  chars) + exit status go back to the model. Background: returns an id immediately. Interrupting
  the agent (Esc/Ctrl+C) kills its foreground command; all agent processes die when Rein exits.
  Claude's `MCP_TOOL_TIMEOUT` is set to 24 h so Rein's own cap is what applies.
- UI: foreground commands pop a live output window that closes itself 1.5 s after they finish
  (Esc hides it, `k` kills). Status line shows `● N background` (always, when N > 0); clicking it
  opens that process's logs directly if there's one, otherwise a list → click → logs (`k` kills).
  `/shells [id]` does the same (classic: printed). Classic shows a live 8-line tail while a
  foreground command runs.
- **list** tool: directory tree (folders first, file sizes), depth 1–5, skips hidden + heavy dirs
  unless `all`.
- **/btw <question>**: forks the agent's live native session — Claude `--resume <id>
  --fork-session --no-session-persistence`, Codex `thread/fork {ephemeral, excludeTurns: true}` —
  and streams the answer into a window while the main turn keeps running. The fork sees the full
  history (verified: it answered from a fact that existed only in an earlier tool result, on both
  providers, mid-reply) and only read-only tools (separate read-only socket; no approvals, no
  transcript activity). Falls back to a context-only one-shot if there's nothing to fork.
  Never added to the transcript.
- Input stays live while the agent works: messages typed then are queued ("N queued") and sent when
  the reply finishes; `/clear`, `/compact`, `/tui`, `/update` wait until idle.
- **Ctrl+C**: first press stops the agent (reply + foreground command), denies a pending approval,
  closes windows and clears the draft, showing "Press Ctrl+C again to exit"; a second press within
  2 s exits. Exiting always takes two presses.

### Verified with the user's real setup (2026-10-02)
- Second Claude account added via `/login` (paste-code flow) → isolated `CLAUDE_CONFIG_DIR`; usage
  windows come through for both Claude accounts. Codex Pro account added too.
- Jev live: key in Keychain; `jev-1.13.0` (aliases `jev-latest`/`jev-preview` currently resolve to
  it) answers routing choices in ~120–130 ms with ~360 input tokens ("2+2" → haiku 1.0; lock-free
  queue → opus 0.96) and approval judgments (rename → allow 0.96). `/v1/models` returns
  `{models: [...]}` — parser fixed so the `/login` confirmation lists them.

## 15. Sessions, scratchpads, compaction display (2026-10-02, built)

- **`rein --continue`** opens a picker of this project's saved conversations (newest first: age,
  message count, first message, models, summarized); click/enter continues one (its recent turns
  and tool calls are replayed), esc starts fresh. `rein --continue <id>` continues directly;
  `/resume` opens the picker in-app (when idle). `/tui` switches carry the current session id.
- **Complete transcripts:** every message is kept on disk (compaction only adds a summary), each
  reply now also stores its tool calls (label, args summary, ok, result ≤4k chars), and each
  transcript records its project `cwd`.
- **Agent tools:** `sessions_search` (regex over messages + tool calls; this project by default,
  `all_projects`; marks the current session) and `session_read` (paged messages with tool calls).
  Live: after /clear the agent found a fact from an earlier conversation via sessions_search.
- **Scratchpad per session:** `~/.rein/scratch/<session-id>/`, named in the system prompt; file
  tools may use it alongside the project, and write/edit/delete inside it skip approval (shell still
  asks). /clear → new folder; resuming → that session's folder.
- **Compaction display:** animated "Compacting N messages…" status, then a rule
  `── ▁▃▅▇ Conversation compacted ───` with `N messages → X-token summary · context A → B (±%) · model`
  and why (manual / auto at N% / handoff / context full). Same for automatic compactions.
- Long tool headers and route lines now wrap; history lines are clipped to the pane width so the
  sidebar never shifts.

## 16. Subagents (2026-10-02, built)

- `agent` tool {task, model ('auto' | provider:model — enum built from the live catalog when the
  session opens), mode 'new' | 'fork', name?, background?}. `fork` branches the parent's live
  native session (full history, same model/account); `new` starts a fresh session on any signed-in
  model; `auto` → the auto router (Jev / decision model) picks for the task. Not gated by approval
  (spawning has no side effects; the subagent's own tool calls are). `agent_result {id, wait?}` for
  background subagents. Subagents get every tool except agent/agent_result (no nesting); fork-mode
  still *sees* their definitions (forked history references them) but can't call them.
- Spike: forking while the parent is mid-tool-call works on both providers (parent inside a
  foreground `sleep`; fork answered from an earlier tool result) — Codex + Claude.
- **Completion check:** when a subagent ends its turn, the decision model answers one noul
  question ("is the task fully complete?") from task + final answer + tool summary; "no" →
  the subagent is told to continue; max 3 extra rounds.
- Tool activity is origin-tagged (`agentId`): subagent activity never lands in the main transcript
  or main reply's tool record; Claude subagents get their own MCP socket; subagent foreground
  shells don't pop the main shell window.
- Approvals are queued (several agents can ask at once): "Approve (1 of 3) · subagent reviewer".
  "Allow all this session" covers every agent.
- Concurrency cap: `/configure` → Subagents (default 10). Esc cancels foreground subagents with
  the main turn; Ctrl+C cancels all. Subagent tokens fold into the session totals; subagent records
  (task, model, mode, status, output, tool calls) are saved on the parent transcript.
- UI: sidebar "Agents" section (click → live window: task, model, streamed text, tool lines; k
  stops), status `● N agents`, `/agents`, main transcript line `Agent(name · model · mode)`.

Status (subagents): verified live on both providers — Claude and Codex main agents each spawned a
`new` subagent with model `auto` (decision model picked Haiku) and a `fork` subagent in the
background, collected both with agent_result, and answered correctly; subagent tool calls stayed
out of the main transcript; records + tokens saved. UI change per the user: subagents are **views,
not windows** — the sidebar Agents section lists `main` + running subagents (+ the one being
viewed; finished ones drop off when you look away, `/agents` lists all); clicking switches the main
pane to that agent's conversation and the input then messages it (sessions stay open after the
task for follow-ups). Esc in a subagent view stops that subagent. Verified: open from /agents → task,
tool calls, completion check shown → follow-up message answered in the subagent view → back to main.

## 17. Advisor, efficiency, diffs (2026-10-02, built)

- **Advisor:** `/model` → Advisor tab: `off` (default) or a specific model (never auto; most capable
  listed first). When set, main agent and subagents get an `advisor` tool ("a more capable, much
  more expensive model — use sparingly") that sends the caller's context (main: summary + recent
  messages with tool calls, ≤40k tokens; subagent: its task + work) and question to that model.
  Hidden entirely when off; changing it refreshes the session's tool list on the next turn.
  Live: haiku consulted Sonnet (Map vs object) and relayed the advice.
- **Efficiency:**
  - read streams lines and stops after the requested range (constant memory; binary check reads 8 KB).
  - edit: in memory ≤ 8 MB; above that a two-pass streaming replace (matches spanning 1 MB chunk
    boundaries handled) into a temp file + atomic rename. Tested on a ~10 MB file.
  - search: bundled ripgrep (`@vscode/ripgrep`, 15.0.0) — parallel, .gitignore-aware, per-file match
    cap; fallback streams files line by line (no size limit).
  - transcripts: append-only JSONL (`<id>.jsonl`: one line per message + meta lines) + small
    `<id>.meta.json` index; saving appends only new lines; listing reads only index files;
    sessions_search runs ripgrep over the logs and parses only matching lines; session_read streams a
    page and stops. Legacy `.json` transcripts migrate automatically. 50 MB session: search 28 ms,
    page 2 ms.
- **Diffs in the chat history:** edit/write results carry a display diff (2 lines of context, ≤40
  lines; region-only for huge files) rendered Claude-Code style — line numbers, red/green bars,
  `+N −M` on the tool line — in the main view, subagent views and resumed sessions. Diffs are never
  sent to the model.

## 18. Built-in skills, skill folders, config.json (2026-10-03, built)

- A skill is a **folder** with at least `SKILL.md` (frontmatter `name`, `description`, then
  instructions); it can carry scripts, templates and other files. (Single-file `<name>.md` skills are
  no longer recognized.)
- Optional `config.json`: `{"name", "description", "main", "aliases"}` — each field falls back to the
  main file's frontmatter, then to defaults (main `SKILL.md`, folder name, first instruction line). A
  missing `main` falls back to SKILL.md. Aliases add `/` names but never beat a skill name or a Rein
  command. Namespaced names (`git:sync`) are allowed; the folder uses `git-sync`.
- Name conflicts: **built-in → project (`<cwd>/.rein/skills`) → global (`~/.rein/skills`)**; built-in
  Rein commands win over all skills.
- Built-ins ship in `<install>/skills`: **`/skill:create`** and **`/skill:edit`** — instructions for the
  agent covering format, scope, locations, config.json, scripts and precedence.
- Invoking a skill tells the agent its folder (`dir=`) and files, and fills placeholders
  `{{SKILL_DIR}}`, `{{PROJECT_SKILLS_DIR}}`, `{{GLOBAL_SKILLS_DIR}}`, `{{BUILTIN_SKILLS_DIR}}`.
- File tools can reach `~/.rein/skills` (approval still applies) so global skills can be created/edited.
- Live: `/skill:create` (haiku) made `.rein/skills/todo-scan/{SKILL.md, config.json}` with name
  `todo:scan` + alias `ts`; `/ts` appeared in autocomplete and ran the skill correctly.

## 19. Goals + orchestration (2026-10-03, built)

- `/goal <text>` sets a standing goal (saved on the transcript, survives resume) and starts the agent
  on it; `/goal pause|resume|clear` (user-only — the agent has no tool to pause or clear) and `/goal`
  (status + review history window). Esc / Ctrl+C pause it.
- Goal loop: after each turn with the goal active (nothing queued, no approval pending, no
  uncollected background subagents), Rein sends the next step. The agent's only goal action is
  `goal_done {summary, evidence}` (listed only while a goal is active): the decision model reviews it
  against **evidence in context** — tool results since the goal started, the agent's evidence and
  last message — and accepts only at ≥ 0.7 ("a bare claim, partial progress or 'impossible' is not
  achieved"). Rejection → the agent is told to produce proof and continue.
- "Impossible" is never a completion: when a turn ends, the decision model checks whether the agent
  gave up (≥ 0.6) → escalate to the **advisor** (if configured) or else a fresh **subagent** (`new`,
  `auto`) investigates, and its input is sent as the next message ("'Impossible' is not a
  completion…"). No cap by default; `/configure` → Goals can set one (10–250 continuations), after which the goal pauses.
- Live (haiku): `/goal create hello.sh … prove it works` → write, chmod, run, goal_done with the
  output → accepted (0.95) → "◎ Goal achieved and verified"; status line `◎ goal · done`.
- **Orchestration:** the main agent can orchestrate (background subagents + agent_result wait) or work
  alongside them (spawn in background, keep using its own tools). Uncollected background reports are
  delivered to the main agent as a message when they finish (deduplicated against agent_result),
  and the goal loop waits for them. Live: main spawned bg-count, read a.txt itself, ended its turn;
  the report arrived and it continued with both results.

## 20. Markdown, highlighted diffs, attachments (2026-10-03, built)

- Replies render markdown like Claude Code (marked lexer → chalk; highlight.js for code blocks):
  headings, emphasis, inline code, nested/task lists, quotes, boxed tables, links, rules.
- Diffs: syntax-highlighted by file extension on Claude Code's dark-theme bars; paired -/+ lines
  get word-level emphasis (brighter bar on changed words).
- Input attachments (src/ui/attachments.ts): bracketed paste (Ink usePaste) of >3 lines / >800
  chars → `[Pasted text #n +N lines]`; Ctrl+V → clipboard image (osascript PNG; wl-paste/xclip)
  → `[Image #n]`; a dropped file (terminal pastes its path) → `[Image #n]` for png/jpg/gif/webp,
  else `[File #n: name]` (inlined as a <file> block up to 256 KB). Backspace deletes a token
  whole. Tokens expand when the message is sent (so queued messages work); images are copied to
  the session scratchpad (`images/`, >3.5 MB downscaled with sips) and sent natively: Claude as
  base64 image blocks, Codex as `localImage` inputs. Live: both providers named both images'
  colors and read the pasted list.
- /context counts tool definitions, tool calls/results and measured "Other"; Claude's context
  figure is the last API call's input (was the turn's sum across tool calls).
- Codex: `skills.include_instructions=false`, `skills.bundled.enabled=false` (its bundled-skills
  developer message was injected into every session).

## 21. Web tools + privacy (2026-10-03, built)

- How the CLIs do it: Claude Code WebSearch = a separate API call with only Anthropic's server-side
  `web_search_20250305` tool (max 8 uses, forced); WebFetch = local fetch (http→https, no
  localhost, cross-host redirects reported, cache) → turndown markdown → Haiku answers the prompt.
  Codex = OpenAI's hosted `web_search` (disabled/cached/live; actions search/open_page/find_in_page),
  no local fetch.
- Rein (src/tools/web.ts), any chat model: `web_search` = one-shot on the /model → Web model
  (default cheapest) with native search on for that call only (Claude `--tools WebSearch
  --allowedTools WebSearch`; Codex `thread/start config {web_search:"live"}` — the app-server keeps
  it disabled for chat threads). `web_fetch {url, prompt?, offset?}` = local fetch (30 s, 10 MB,
  same-host redirects, cross-host reported, private/loopback hosts refused, 15-min cache) →
  turndown; with prompt the web model answers from ≤120k chars, else 40k-char pages. Read-only
  (no approval). Live: Haiku and gpt-6-luna both searched + fetched Deno's release page.
- Privacy (/configure → Privacy, default on): accounts render as "Claude Account N" / "Codex
  Account N" (saved order); history/window lines pass through redact() (known emails → names, home
  → ~, username → user). Live: no email/username anywhere on screen or in /usage.
