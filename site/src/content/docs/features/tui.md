---
title: The terminal UI
description: Rein's fullscreen and classic renderers, the clickable top bar and sidebar, windows, input tricks like paste collapse and @mentions, privacy mode and every /settings tab.
---

Rein runs as a full terminal app: a live status bar you can click, a sidebar that shows every account's usage at a glance, windows that open over the conversation while it keeps streaming, and an input box that understands pastes, images, dropped files and `@mentions`. If you prefer your terminal's own scrollback, one flag switches to the classic inline renderer.

## At a glance

This is a fullscreen session mid-reply, with the default status line and sidebar:

```text title="rein"
▁▃▅▇ Rein │ auto · Sonnet │ Claude Account 1 │ 5h 12% · weekly 31% │ ctx 18%            [≡]
                                                              │AGENTS
> add a --json flag to the export command                     │▸ main ●
                                                              │
  → Sonnet · Claude Account 1 (auto · 0.86)                   │ACCOUNTS
                                                              │Claude Claude Account 1
  I'll start by reading the export command.                   │ 5h     ██░░░░░░░░░░░  12%
                                                              │ weekly ████░░░░░░░░░  31%
                                                              │Codex Codex Account 1
                                                              │ 5h     █░░░░░░░░░░░░   4%
                                                              │
                                                              │CHAT MODEL
                                                              │● auto
                                                              │○ Sonnet · Claude
                                                              │
                                                              │SESSION
                                                              │2 messages
                                                              │↻ compact
▃▅▇▅ Read(src/commands/export.ts)… (12s · ↑ 8.4k ↓ 312 · esc to interrupt · /btw to ask)
╭──────────────────────────────────────────────────────────────────────────────────────╮
│ > queue a message, or /btw <question>                                                │
╰──────────────────────────────────────────────────────────────────────────────────────╯
 esc interrupt · ctrl+c stop (twice to exit) · wheel/PgUp scroll · ⇧↵ / ⌥↵ / \↵ newline · ctrl+b sidebar
```

Every segment of that top bar is a button, every account and model in the sidebar is clickable, and nothing on screen shows your real email.

## Fullscreen or classic

| | Fullscreen (default) | Classic |
|---|---|---|
| Screen | Alternate screen, sized exactly to the terminal | Inline in your normal terminal |
| History | Virtualized, scrolled with the wheel or PgUp/PgDn | Printed to native scrollback |
| Mouse | Clicks, wheel, drag-to-select-and-copy | None |
| Status | Clickable top bar + sidebar | One plain status line under the input |
| Command output | Opens in centered windows | Printed into the transcript |

Pick one at launch with `rein --fullscreen` or `rein --classic`, or switch inside a session:

```text title="rein"
/tui classic
```

The choice is saved as `tui` in `~/.rein/config.json`, and the current conversation carries over into the other renderer. `/tui` waits until the agent is idle. When you quit fullscreen, Rein prints the conversation into your normal terminal history so it's still there after the alt screen closes.

The classic renderer starts with a banner (`▁▃▅▇ Rein <version>  /help for commands`) and shows a dim status line built from the same segments, plus `● N background (/shells)`, `⏸ plan mode` and `◎ goal <status>` when they apply.

:::tip[Mouse in Terminal.app]
Fullscreen needs mouse reporting for clicks and scrolling. In macOS Terminal.app, turn on **View → Allow Mouse Reporting**.
:::

## The top bar

The bar starts with the `▁▃▅▇ Rein` mark, followed by the segments you've enabled in `/settings → Status line`, separated by `│`. These are the available segments, with the default ones marked:

| Segment | Shows | Click |
|---|---|---|
| Model (default) | The chat model. In auto mode, `auto · <routed model>` | Opens `/model` |
| Account (default) | The account serving the conversation, or `N accounts` before the first reply | `/usage` |
| Usage (default) | That account's windows, e.g. `5h 12% · weekly 31%` | `/usage` |
| Context (default) | `ctx 18%`: green, yellow from 50%, red from 80% | `/context` |
| Sidebar button (default) | `[≡]` at the far right | Toggles the sidebar |
| Decision model | `decides: Jev`, or the LLM that routes auto mode | `/model` |
| Messages | `N msgs` | `/context` |
| Advisor | `advisor: off` or the advisor model | `/model` |
| Approvals | `edits: ask` (green), `auto` (yellow), `bypass` (red) | `/settings` |

Rein adds some segments on its own when they apply:

- `◂ main · viewing reviewer` when you're looking at a subagent. Click it to go back to the main agent.
- `⏸ plan mode` (yellow). Click it to turn plan mode off. See [Plans](../plans/).
- `◎ goal · active · 3/5`: the goal status, plus milestone progress for a plan-linked goal. Click it to open the goal window. See [Goals](../goals/).
- `● 2 agents` when subagents are running. Click it to open the agent, or `/agents` if several are running. See [Subagents](../subagents/).
- `● 1 background` or `● 3 background processes` for background shells. Click it to open `/shells`.

The bar never wraps. On a narrow terminal it drops segments, starting with the last segments you configured and then background, agents, goal and plan mode, until it fits.

While you view a subagent, the model, account, usage and context segments show that subagent's values instead of the main agent's.

## The sidebar

The sidebar is 32 columns wide on the right. `Ctrl+B` or the `[≡]` button toggles it, and Rein remembers your choice. It hides automatically when the terminal is narrower than 96 columns. You pick its sections, and their order, in `/settings → Sidebar`:

| Section | What it shows |
|---|---|
| **Agents** (default) | `main` plus running subagents (and the one you're viewing). Click one to switch the main pane to its conversation and message it. |
| **Accounts** (default) | Every account with a usage bar per window (`5h`, `weekly`, `30-day`). Bars turn yellow at 70% and red at 90%. Click to open `/usage`. With no accounts you get `+ add an account`. |
| **Chat model** (default) | `auto` and every model you can use. Click one to switch. |
| **Session** (default) | Message count, uncached, cached and received token totals, and `↻ compact`, `⚙ accounts` and `☰ configure` shortcuts. |
| Context | A fill bar for the active model (or the subagent you're viewing). |
| Auto routing | The decision model and the last routing decision. |
| Shortcuts | A key and mouse cheatsheet. |

Two more sections appear at the top when they're relevant:

- **GOAL · 3/5**: when a goal is working from a plan. Shows the plan title, a progress bar and the milestones (`✓` done, `▸` next, `○` later).
- **TASKS 2/5**: the agent's task list from `todo_write`, shown while any task is unfinished. Completed tasks are struck through.

## Windows

In fullscreen, commands that show information or ask you something open a centered window over the conversation. The agent keeps streaming underneath while the window is open. Windows have a dark grey background and a rounded cyan border. Approval windows use a yellow border.

- Close a window with `Esc`, the `[×]` button, or a click outside it. Read-only windows (usage, context, help) also close with `q` or `Enter`, and scroll with `↑↓`, PgUp/PgDn or the wheel.
- Approval windows (`Approve command`, `Approve file change`) don't close on an outside click, so a stray click can't decide for you. When several approvals are waiting, the title shows the count and who asked, e.g. `Approve file change (1 of 3) · subagent reviewer`.
- Windows with tabs (`/model`, `/settings`) keep the same size whichever tab you're on.
- A window keeps its height while open, so its content doesn't jump around as it changes.

Windows include `Accounts` (`/login`), `Models`, `Usage`, `Context`, `Commands` (`/help`), `Configure`, `Rewind`, `Continue a conversation` (`/resume`), `MCP servers`, `Questions from the agent`, `Plan — approve to start`, the goal window, the agents and shells lists, and `btw · <question>`.

A running foreground command shows its last lines inline above the input. Click it to open the full output.

## Mouse and scrolling

- **Wheel** scrolls the history three lines at a time. **PgUp/PgDn** scroll a page, and **End** jumps back to the latest message.
- When you've scrolled up, new output doesn't move your view. The activity line shows `↓ 42 lines below · End or click to jump to latest`.
- **Drag** over the history to select text. Releasing the mouse copies it and flashes `✓ Copied 128 characters`. Dragging past the top or bottom edge scrolls. Rein copies with the native clipboard tool (`pbcopy`, `clip`, `wl-copy`, `xclip` or `xsel`) and also sends OSC 52, so copying works over SSH in terminals that support it.

## The splash screen

An empty conversation shows the splash: the `▁▃▅▇▅▃▁` bar logo above a block-letter **REIN** wordmark in a slowly drifting diagonal rainbow, with the tagline and some tips:

```text title="rein"
                              ▁▃▅▇▅▃▁

                 ██████╗ ███████╗██╗███╗   ██╗
                 ██╔══██╗██╔════╝██║████╗  ██║
                 ██████╔╝█████╗  ██║██╔██╗ ██║
                 ██╔══██╗██╔══╝  ██║██║╚██╗██║
                 ██║  ██║███████╗██║██║ ╚████║
                 ╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝

                     One CLI, Every Workflow

 type a message to start  ·  / for commands  ·  @ to attach a file  ·  /model to pick a model
```

It fades in over 700 ms at launch, fades out over 900 ms when you send your first message, and comes back after `/clear`. Narrow panes get a compact one-line version.

## The working indicator

While the agent works, the line above the input shows Rein's mark: a four-cell bar wave (`▇▅▃▁`) with a rainbow flowing through it and a brighter band sweeping across the label. The label tells you what's happening:

- `Routing…`: auto mode is choosing a model.
- `Thinking…`, then `Responding…`.
- The name of the running tool and its argument, e.g. `Read(src/commands/export.ts)…`.

After the label come the elapsed time, tokens in and out, any queued messages, and a reminder of what you can do:

```text
▁▃▅▇ Responding… (1m 05s · ↑ 24k ↓ 1.2k · 2 queued · esc to interrupt · /btw to ask)
```

The same line shows compaction and goal checks while they run. When you view a finished subagent, it reads `reviewer done after 2m 14s · type to message it · ◂ main in the sidebar or /agent main to go back`.

## Input

The input box grows up to six lines and has a few tricks:

- **New lines**: `Shift+Enter` (in terminals with the kitty keyboard protocol), `Option+Enter`, `Ctrl+J`, or end the line with `\` and press `Enter`. The last one works in every terminal.
- **Big pastes collapse.** A paste longer than 3 lines or 800 characters becomes `[Pasted text #1 +42 lines]`. The full text is sent with your message, but your history keeps the short token.
- **Images from the clipboard.** `Ctrl+V` pastes the clipboard image as `[Image #2]`. This uses AppleScript on macOS, PowerShell on Windows, and `wl-paste` or `xclip` on Linux. On macOS, images over 3.5 MB are downscaled with `sips`.
- **Drag and drop.** Drop files onto the terminal. Images become `[Image #n]` and are sent to the model as images. Other files become `[File #3: notes.md]`, and text files up to 256 KB are included in the message.
- **Backspace** after a token deletes the whole token and its attachment.
- **`@mentions`.** Type `@` and part of a path to get fuzzy matches from your project's files and folders (from `rg --files`, so `.gitignore` is respected). `Tab` or `Enter` inserts the selected match. On send, a mentioned file's contents, image or folder listing goes along with your message.
- **Slash commands.** Type `/` for a list of commands and skills. `↑↓` selects and `Tab` completes.
- **A real line editor.** Move with `←/→` (by word with `Option`/`Alt`), `Home`/`End` or `Ctrl+A`/`Ctrl+E`, delete words with `Ctrl+W`, and edit anywhere in the draft. `↑` on the first row recalls earlier messages in this project, even from past sessions. `Ctrl+G` opens the draft in `$EDITOR` for long prompts. `Ctrl+R` searches your earlier messages, and `!command` runs a shell command yourself. Full list in [Keyboard & mouse](../../reference/keys/).
- **Queueing.** While the agent is busy, messages you send are queued and run in order when it finishes. The placeholder reads `queue a message, or /btw <question>`. [`/btw`](../btw/) runs right away. `/clear`, `/compact`, `/tui`, `/update` and `/resume` wait until the agent is idle.

## Stopping and exiting

- **Esc** interrupts the reply, or the subagent you're viewing. With a window open, Esc closes the window.
- **Esc Esc** (within 600 ms, while idle with an empty input) opens [`/rewind`](../rewind/).
- **Ctrl+C** stops everything at once. It interrupts the reply (or kills the foreground command), cancels subagents, pauses any active goal, denies pending approvals, closes windows and clears the input. Pressing it again within 2 seconds exits. The footer warns you with `Press Ctrl+C again to exit`.
- **Shift+Tab** toggles [plan mode](../plans/).

See [Keyboard shortcuts](../../reference/keys/) for the full list.

## Privacy mode

Privacy mode is on by default, so you can share screenshots without editing them first:

- Accounts show as `Claude Account 1`, `Codex Account 1` and so on, instead of their emails.
- Any known account email in rendered text is replaced with that account name.
- Your home folder shows as `~`.
- Your OS username shows as `user` when it's 5 or more characters, so short names don't match ordinary words.

To see real emails and paths, go to `/settings → Privacy` (or set `hidePersonalInfo` to `false`).

## /settings

`/settings` opens a window with tabs. Changes save to `~/.rein/config.json` right away, and the bar and sidebar behind the window update as you toggle. `←→` or `Tab` switches tabs, `Enter`, `Space` or a click chooses, and `Esc` closes.

| Tab | Options (default in bold) | Config key |
|---|---|---|
| **Status line** | Toggle and reorder top-bar segments (`▲▼`, `Shift+↑↓` or `[` `]`). `r` resets. Default: **Model, Account, Usage, Context, Sidebar button**. | `statusLine` |
| **Sidebar** | Toggle and reorder sidebar sections. Default: **Agents, Accounts, Chat model, Session**. | `sidebarSections` |
| **Approvals** | **Ask** (confirm every file change) · Auto (the decision model approves changes that clearly match your request, and asks you otherwise) · Bypass | `toolApproval` |
| **Shell** | Longest a foreground command may run: 10, 30, 60 minutes · **2 hours** · 4, 8 hours · No limit. The agent picks a timeout per command (2 minutes by default) up to this cap. Background processes have no limit. | `shellMaxMinutes` |
| **Subagents** | How many may run at once: 1, 2, 3, 5, **10**, 20 | `subagentLimit` |
| **Goals** | Automatic continuations before a `/goal` pauses itself: **Unlimited**, 10, 25, 50, 100, 250 | `goalMaxRounds` |
| **Load balancing** | **Balanced** (cache-aware) · Sticky (stay on one account until it hits a limit) | `loadBalancing` |
| **Sandbox** | **On**: the agent's commands can only write inside the project, scratchpad, temp folders and package caches · Strict: also no network except localhost · Off | `sandbox` |
| **Worktrees** | **Automatic**: parallel subagents get their own git worktree, merged back when they finish · Off | `worktrees` |
| **API accounts** | **Fallback**: pay-per-use API accounts only when no subscription can serve the model · Always: alongside subscriptions (after them) | `apiAccounts` |
| **Notifications** | **Terminal** (bell + terminal notification) · Desktop (also macOS / Linux notifications) · Off. Fires when Rein needs you (approval, question, plan, hook trust) and when work that took 20 s or more finishes | `notifications` |
| **Updates** | **Auto-update Rein** on launch · Only when I run `/update` | `autoUpdate` |
| **Privacy** | **Hide personal info** · Show emails and paths | `hidePersonalInfo` |
| **Compaction** | Auto-compact at 50, 60, 70, **80**, 90 or 95% of the context window (mid-turn too; the agent keeps working), or Off (only `/compact`, or when a model rejects a full context) | `autoCompactPct` |

:::note
Rein reads and searches files without asking in every approval mode. The Approvals tab controls what happens when the agent wants to change something. See [Permissions](../permissions/).
:::

## Related

- [Keyboard shortcuts](../../reference/keys/)
- [Configuration reference](../../reference/configuration/)
- [Accounts and usage](../accounts/)
- [Subagents](../subagents/)
- [Load balancing](../../internals/load-balancing/)
