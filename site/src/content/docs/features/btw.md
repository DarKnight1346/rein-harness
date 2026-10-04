---
title: Side questions (/btw)
description: Ask a quick question about the work in progress and get an answer from a fork of the live agent, without interrupting it or polluting the conversation.
---

The agent is twenty tool calls into a refactor and you want to know which file it decided to split first. Stopping it would cost you the momentum; queuing the question means waiting until it finishes. `/btw` does neither: Rein **forks the agent's live native session** — full history, every tool result it has seen — and the fork answers you while the original keeps working.

## Quick example

While the agent is busy, the input box says `queue a message, or /btw <question>`, and the working line reminds you too:

```text title="rein"
▇▅▃▁ Edit(src/store/config.ts)…  (2m 14s · ↑ 48k ↓ 3.1k · esc to interrupt · /btw to ask)

› /btw which config loader did you settle on, and why?
```

A window opens straight away and the answer streams into it:

```text title="rein"
╭─ btw · which config loader did you settle on, and why? ──────────╮
│                                                                   │
│  The new `loadConfig()` in src/store/config.ts. It replaces the   │
│  two ad-hoc readers because both silently ignored unknown keys…   │
│                                                                   │
│  Sonnet · forked agent · not added to the conversation            │
╰───────────────────────────────────────────────────────────────────╯
```

Close it with Esc. The main agent never noticed.

## How the fork works

`/btw` branches the session the main agent is running in, on the **same model and the same account**, so the side answer is grounded in exactly what the agent knows — including file contents and command output it read minutes ago, not only the chat text.

| Provider | How the branch is made |
| --- | --- |
| Claude Code | A second `claude` process resumes the live session with `--resume <id> --fork-session --no-session-persistence`: a new session id, nothing written to disk, the original untouched. |
| Codex | `thread/fork` on the account's app-server with `ephemeral: true`: a new thread carrying the full history while the original thread keeps running. |

Your question is wrapped in a `<side_question>` preamble that tells the branch to answer briefly and directly, and not to continue, redo or change the main task. When the answer is done, the branch is closed.

### Read-only tools

The fork sees the same tool list as the main agent (its history references those tools), but only tools that aren't flagged as mutating actually run. `read`, `list`, `search`, `web_search`, `web_fetch`, session search and friends work, so the fork can look something up to answer you. Mutating tools and tools that belong to the main agent alone are refused with:

```text
edit is not available while answering a side question
```

That covers `write`, `edit`, `delete`, `shell`, `image_generate`, `mcp_add` and `mcp_remove`, plus main-agent tools like `agent`, `ask_user`, `todo_write`, `present_plan` and `goal_done`. Fork tool calls skip the approval prompt and don't show up in the conversation's activity.

## Never part of the conversation

The question and the answer live only in the window (or, in classic mode, as an info line). Neither is written to the transcript, so:

- the main agent never sees the exchange and can't be steered by it,
- the side question doesn't eat into the conversation's context window,
- resuming the session later shows no trace of it.

If you want the agent to act on what you learned, send a normal message — it queues behind the current turn.

## When there's nothing to fork yet

A fork needs a live native session. Before the first reply, right after `/compact` or `/rewind`, or if the fork fails before producing any text, Rein falls back to a **one-shot answer from the conversation**: the current chat model gets the newest messages that fit in about 24,000 tokens (plus the compaction summary for anything older), a note if the agent is still working, and your question. No tools are available in this mode. The footer tells you which path answered:

```text
Sonnet · from the conversation · not added to the conversation
```

## Asking about a subagent

`/btw` follows what you're looking at. If you've switched the view to a subagent (from the sidebar's Agents section or with `/agent <id>`), the question is answered from **that subagent's** messages and tool calls, on the subagent's model and preferably its account. The footer reads, for example, `Haiku · about reviewer · from the conversation`. This path is always a one-shot over the subagent's conversation (the last ~96,000 characters), not a live fork, so it never interferes with the subagent's run.

## Details and limits

- **Runs immediately.** Plain messages typed while the agent works are queued; `/btw` is not. In fullscreen, a new `/btw` replaces the window of the previous one.
- **Costs usage on the parent account.** The fork runs on the same account as the main session, because that's where the native session lives.
- **Classic mode** has no windows: you get `btw: <question> (answering…)` and then a `btw → …` line followed by a footer such as `(Sonnet · forked agent · not added to the conversation)`.
- **Errors** are shown in the window (or as `btw failed: …`) and never touch the main turn.
- **Empty `/btw`** prints the usage hint: `Usage: /btw <question> — answered from the conversation without interrupting the agent.`

## Related

- [Subagents](../subagents/) — the same fork mechanism powers `agent` with `mode: "fork"`.
- [Rewind](../rewind/) — undo code and conversation when the agent went the wrong way.
- [The TUI](../tui/) — windows, the working indicator and message queueing.
- [Context management](../../internals/context/) — how native sessions relate to Rein's own transcript.
- [Commands reference](../../reference/commands/)
