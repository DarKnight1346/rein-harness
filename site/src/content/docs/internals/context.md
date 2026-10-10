---
title: Context & compaction
description: How Rein keeps one transcript as the source of truth, treats native CLI sessions as disposable caches, carries context across models and accounts, and compacts long conversations.
---

Rein switches models, accounts and even providers in the middle of a conversation, and the model on the other side still knows what happened. That works because the native `claude`/`codex` sessions are not where the conversation lives. Rein's own transcript is. A native session is a **cache** of that transcript: Rein reuses it while it's valid and rebuilds the missing part when it isn't.

This page covers that mechanism. It lives in `src/session/engine.ts`, `src/session/transcript.ts`, `src/session/carry.ts` and `src/session/compactor.ts`.

## The transcript is the truth

Every conversation is a `Transcript` (`src/session/transcript.ts`): the messages, the tool calls on each reply (label, argument summary, ok, the result clipped to 4,000 characters), an optional compaction `summary`, and a map of native sessions:

```ts
/** A native session that has seen `messages[0..coversUpTo)` (or the summary + messages after it). */
export type NativeRef = {provider: string; accountId: string; nativeId: string; coversUpTo: number};
```

`transcript.native` is keyed by `${provider}:${accountId}`. That's the cache key. A Claude session on Claude Account 1 and one on Claude Account 2 are different caches of the same conversation. Each one records **how far into the transcript it has seen** (`coversUpTo`).

On disk, the transcript is an append-only JSONL log in `~/.rein/sessions/<id>.jsonl` plus a small `<id>.meta.json` index (see [Files & directories](../../reference/files/)). Saving appends only new lines, so a long conversation is never rewritten.

**Crash safety.** Your message is written before the turn starts, and while the agent works each finished tool call is appended as a small `progress` line, together with the reply text since the previous one. If Rein stops in the middle of a turn (a crash, a closed terminal, a reboot), loading the session rebuilds that turn as a **cut-off reply** (`cutOff: true`): the text and every tool call up to that point. `/resume` and `rein --continue` say so ("Rein stopped in the middle of this turn; its work so far was saved…"), and the agent sees the work in its context, so "continue" picks up where it stopped instead of starting over.

## Resume or rebuild

Before each turn, `Engine.prepare()` decides whether the native session can be reused:

1. If the live session belongs to another `(provider, account)`, close it.
2. If the effort changed: Codex takes effort per turn (`setEffort`); Claude's is fixed per process, so the session is closed and reopened (it resumes, so nothing is lost).
3. With no live session, look up `transcript.native[key]`. **Resume only if `coversUpTo === userIndex`**, meaning the native session saw every message up to the new one. Otherwise open a fresh native session and carry the missing part.
4. A model change within the same session is free: Claude gets a `set_model` control request, Codex takes the model on the next `turn/start`.

After every completed turn, `markCovered()` records the native id and the new `coversUpTo`. Several things deliberately break the cache:

| Event | What happens |
| --- | --- |
| Compaction | `t.native = {}`, so the next turn starts a fresh session from the summary. Resuming would reload the full history and undo the compaction. |
| `/rewind` | `t.native = {}`, and the summary is dropped if it covered the rewound part. |
| Tool list changes (advisor switched on, an MCP server adds tools) | `refreshTools()` closes the live session. The next turn **resumes** it (same history) with the new tool list. |
| Account removed | `releaseAccount()` drops the session after the running turn finishes. The next turn carries the context to another account. |

## Context carry

When a session hasn't seen part of the conversation (a new account, a provider switch, a failover), `buildCarry()` prepends what's missing to the user's message:

```text
<earlier_conversation>

This conversation started before you joined it (another model or session). Continue it naturally; do not mention the handoff. Tool calls you see here were made by you earlier; results not shown in full can be re-read if needed.

<summary>
…compaction summary, if the session predates it…
</summary>

User: …
Assistant: [tool Read(src/x.ts) ✓]
…
</earlier_conversation>
```

`carryStart()` picks the first message to include. If a summary covers more than the session saw, the carry starts at the summary and skips the folded messages.

### Which tool results travel

Text alone loses what was read, run and changed. Carrying every tool result can blow the budget. `src/session/carry.ts` resolves this in three tiers:

1. **All of them** if their results fit `CARRY_TOOL_BUDGET` (12,000 tokens).
2. Otherwise the **compaction model picks**. It sees a one-line index per call, never the result bodies:

   ```text
   #3 Read(src/session/engine.ts) ok · ~5200 tokens · import {adapters} from '../providers/index.js';
   #4 Shell($ npm test) FAILED · ~800 tokens · [exited 1]
   ```

   and returns a JSON array of indices, most important first. Its prompt (in `Runtime.selectCarry`, `src/runtime.ts`) asks for the latest contents of files being worked on, recent errors and test output, and results still in use, and tells it to drop superseded reads and routine listings. Rein keeps its picks in order until the budget or `MAX_PICKED` (24) is reached.
3. If the selector fails or returns nothing, the **most recent** results that fit.

Everything not picked becomes a one-line trace, `[tool Edit(src/x.ts) ✓]`, so the new session still knows the step happened and can re-read the file. When the selection kicks in, you see a notice:

```text title="rein"
Context carried over: 7 of 31 tool results (chosen by the compaction model), the rest as one-line traces
```

### When the carry is too big

The conversation text has its own budget, `CARRY_BUDGET_TOKENS` (24,000) in `engine.ts`. If the carried prompt exceeds it, the engine runs a **handoff compaction** first and rebuilds the carry from the summary. The load balancer also checks this: it won't move a conversation to a better account if the move would force a compaction (see [Load balancing](../load-balancing/)).

## Compaction

`compactTranscript()` (`src/session/compactor.ts`) folds older messages into a structured summary with the compaction model (`/model` → Compaction model, `cheapest` by default). The system prompt asks for these sections, omitting empty ones:

```text
GOAL: what the user is trying to accomplish.
KEY FACTS & DECISIONS: everything established so far, including names, numbers, file paths, code identifiers and exact values (verbatim).
USER PREFERENCES: tone, format, constraints the user asked for.
CODE & ARTIFACTS: essential code or text produced, verbatim if short, otherwise its gist and key signatures.
OPEN QUESTIONS / NEXT STEPS: what was pending when the transcript ends. If it ends in the middle of a task, say exactly where the work stopped and what the next step is.
```

The compaction model sees each message's text plus a one-line trace per tool call with a short excerpt of its result (`renderForSummary`), so a summary of a tool-heavy turn knows what was read, run and changed.

Details worth knowing:

- **Kept messages.** The last `KEEP_RECENT` (4) messages stay verbatim. `/compact` keeps 2. A mid-turn compaction keeps none: the turn itself is what filled the context.
- **Chunked folding.** No more than `CHUNK_TOKENS` (60,000) of transcript goes into one call. Longer histories are folded chunk by chunk: each call gets `EXISTING SUMMARY` plus `NEW TRANSCRIPT TO FOLD IN`. A 500k-token conversation compacts on a model with a much smaller window.
- **Nothing is deleted.** Messages stay on disk. Only `summary = {text, coversUpTo, map}` is added, and `native` is cleared.
- **A map of what was summarized.** Next to the summary, Rein keeps a list of the parts it covers, one per message you sent, with the files each part changed. It's built from the transcript, not by the model, so it stays exact across repeated compactions:

  ```text
  EARLIER PARTS OF THIS CONVERSATION (summarized above; the full messages are kept — restore one with recall {from, to}, or find something with recall {query}):
  #1-2 "Fix the date parser in src/date.ts" · changed src/date.ts
  #3-4 "Now add a CLI flag --week" · changed src/cli.ts
  ```

  The model gets the map with the summary. When the summary isn't enough (exact code, an error message, the reasoning behind a decision), the agent brings a part back verbatim with the `recall` tool, tool results included. Very long conversations list their first 10 and last 30 parts.
- **A file too.** Each compaction writes the summary and map to `summary.md` in the session's [scratchpad](../../reference/files/), for you to read.
- **Focus.** `/compact what to keep` tells the compaction model to keep everything about that in full detail and be brief about the rest.
- **Subfolder instructions reset.** After a compaction, scoped `AGENTS.md`/`CLAUDE.md` files are delivered again on the next tool call that touches them, because the summary may not keep them word for word.

### Triggers

| Reason | When | Line shown after it |
| --- | --- | --- |
| `manual` | You run `/compact` | `You ran /compact · the next reply starts from the summary · /context for details` |
| `midturn` | While the agent works, a request's input reaches `autoCompactPct` of the window. The agent carries on (see below) | `Compacted mid-task at 80% of the context window — the agent carries on from the summary` |
| `auto` | After a turn, input tokens ≥ `autoCompactPct` of the window (default 80%) | `Auto-compacted at 80% of the context window · change it in /settings → Agents → Compaction` |
| `handoff` | A carry into a new session would exceed 24k tokens | `Compacted before handing the conversation to another model` |
| `idle` | Experiment `idle-compact`, in the TUI: the conversation sat idle until 2 minutes before its prompt cache expires (58 minutes after the last request; 4 minutes with `cache-5m`), and its last request was at least 40% of the auto-compact size. The open session writes the summary from its warm cache, so your next message starts small instead of re-reading the whole history uncached. Once per idle stretch; a message you send meanwhile waits for it | `Compacted while idle, before the prompt cache expired · your next message starts from the summary` |
| `context` | The model rejected the prompt as too long (Claude: "prompt is too long"; Codex: `contextWindowExceeded`). If the agent had already done work in the turn, it's kept and the agent carries on like a mid-turn compaction; otherwise the engine compacts and retries the request once | `The model's context window was full — compacted, and the agent carries on` |

### Compacting without stopping the agent

A long agentic turn (dozens or hundreds of tool calls) can fill the context long before the agent ends its turn. Rein watches the input size of every request inside a turn. When one reaches `autoCompactPct` of the window, the engine (`Engine.send`):

1. **stops the turn between steps.** It interrupts the native session right as a new request starts, or as soon as a running tool finishes. It never stops a tool mid-run;
2. **saves the work so far** as an assistant message, with its tool calls;
3. **compacts** everything into the summary, keeping no messages verbatim;
4. **sends a continuation** in a fresh session: the summary, then a `<context_compacted>` note telling the agent to pick up exactly where it stopped instead of starting over or asking you, followed by its most recent tool results verbatim (newest first, within the 12k-token carry budget) so it keeps its working memory.

The check skips a segment's first request (nothing has happened yet that a compaction would fold away), so a continuation never triggers another compaction straight away. Tool results stored in the transcript are clipped to 4,000 characters and marked `[truncated: N characters in full …]` when there was more.

To you it's one continuous turn with a "Conversation compacted" rule in the middle. The continuation is stored as a `synthetic` message: it doesn't appear in `/rewind`, and the approval judge and checkpoints keep using your real request. At most `MAX_MIDTURN_COMPACTIONS` (20) happen per turn, as a backstop against loops. A user interrupt (Esc) always wins over a pending compaction.

Claude's own auto-compaction is turned off for chat sessions (`DISABLE_AUTO_COMPACT=1`), so Rein's threshold is the only one and the history never changes behind Rein's back.

The auto trigger (`maybeAutoCompact`) uses the provider's measured input tokens for the last request when available, and falls back to a ~4 chars/token estimate. The window is the model's real one, learned from the CLI (`result.modelUsage[*].contextWindow` on Claude, `models_cache.json` on Codex) and remembered in `~/.rein/state/context-windows.json`. If nothing is known, 200k is assumed. With `autoCompactPct: 0`, auto-compaction is off, both after turns and mid-turn; `/compact` and the `context` recovery still work.

While it runs you see `Compacting N messages…`, then a rule:

```text title="rein"
── ▁▃▅▇ Conversation compacted ─────────────────────────────
  48 messages → 2.1k-token summary · context 96k → 9.4k (−90%) · Haiku
  Auto-compacted at 80% of the context window · change it in /settings → Agents → Compaction
```

## Context warnings

The first time the context passes **50%**, **70%** and **85%** of the model's window, Rein says so after the turn, with the biggest tool results in it:

```text
Context is 72% full (144K of 200K tokens). Largest: Read(src/huge.ts) 40K, Shell($ npm test) 12K. /compact summarizes it now (/compact keep <what> steers the summary); /context shows the rest.
```

Each level warns once per stretch of conversation; after a compaction they start over. There's no warning when auto-compaction is about to run anyway. Sizes are of the full tool results (what the model received), not the 4,000 characters Rein stores. Turn the warnings off with `/settings contextWarnings false`.

## `/context`

`/context` opens a live grid (`src/ui/ContextView.tsx`, data from `src/session/context.ts`): 20 × 8 cells, filled in proportion to the model's window, with a legend.

| Category | What it counts |
| --- | --- |
| System prompt | Rein's prompt, including instruction files and memory |
| Tool definitions (N) | The tool schemas as sent to the model |
| Summary | The compaction summary, if any |
| Messages | Messages after the summary, plus the reply in progress |
| Tool calls & results | Tool lines and their stored results |
| Other (provider overhead, full tool output) | Measured input minus Rein's estimate |

Rein's own numbers are estimates (~4 chars/token). When the provider measured the last request on the same model, the header says `measured` and the difference shows as **Other**. That covers CLI overhead and full tool outputs Rein only keeps 4,000 characters of. Claude's figure is the **last API call's** input, not the turn's sum across tool calls, so it reflects what the context holds right now. The footer shows message count, how many were folded into the summary, and where auto-compaction will trigger.

Below the grid, **Largest items** lists the 8 biggest single things in the main conversation's context, largest first: each instruction file (`instructions /path/AGENTS.md`), the compaction summary, and each tool result (`Read(src/huge.ts)`, `Shell($ npm test)`). Sizes are of the full results the model received. Items under about 200 tokens are left out. It shows what to drop: a huge file read whole, a test log, an instruction file that's grown too big.

When you're viewing a subagent, `/context` shows that subagent's context instead. For a fork, the parent's inherited history appears under "Inherited from the parent + provider overhead".

## Related

- [Load balancing](../load-balancing/): when a conversation moves between accounts
- [Drivers](../drivers/): how sessions are opened, resumed and forked on each CLI
- [Decision model](../decision-model/): the other cheap model in the loop
- [Configuration](../../reference/configuration/): `compactionModel`, `autoCompactPct`
- [Rewind](../../features/rewind/): truncating the transcript
