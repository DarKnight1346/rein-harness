---
title: Keyboard & mouse
description: Every keyboard shortcut and mouse action in Rein's fullscreen and classic renderers.
---

Rein follows Claude Code's conventions wherever it can: Esc interrupts, Esc twice rewinds, Shift+Tab toggles plan mode, Shift+Enter adds a new line. The fullscreen renderer adds mouse support on top.

## Everywhere (fullscreen and classic)

### Control

| Key | What it does |
|---|---|
| **Enter** | Sends the message. With the command or file list open, fills in the highlighted entry instead. |
| **Esc** | Interrupts the current reply and pauses an active goal. Rein keeps what was said. While viewing a subagent, stops that subagent. |
| **Esc Esc** | With nothing running and an empty input, two presses within 0.6 s open `/rewind`. |
| **Ctrl+C** | Stops everything at once: the reply, the foreground shell command, all subagents, an active goal (paused), pending approvals (denied), open windows and your draft. |
| **Ctrl+C Ctrl+C** | A second press within 2 s exits Rein. In between, the footer shows `Press Ctrl+C again to exit`. |
| **Shift+Tab** | Toggles [plan mode](../../features/plans/) (when no suggestion list is open). |

### Editing the input

| Key | What it does |
|---|---|
| **Shift+Enter** | New line, in terminals that report it (kitty keyboard protocol). |
| **Option+Enter** / **Alt+Enter** | New line. |
| **Ctrl+J** | New line. |
| **`\` then Enter** | New line, in every terminal. |
| **← / →** | Move the cursor. Edits happen at the cursor, anywhere in the draft. |
| **Option+← / →** (Alt, or Ctrl+← / →) | Move by word. |
| **Home / End**, **Ctrl+A / Ctrl+E** | Start / end of the current line. |
| **↑ / ↓** | Move between rows of a multi-line draft. On the first row, **↑** recalls your earlier messages in this project (kept across sessions); **↓** walks forward and back to your unsent draft. |
| **Backspace** | Deletes the character before the cursor. A placeholder token such as `[Pasted text #1 +42 lines]` or `[Image #1]` right before the cursor is deleted whole, attachment included. |
| **Delete** (fn+Delete) | Deletes the character under the cursor. |
| **Ctrl+W** / **Option+Backspace** | Deletes the word before the cursor. |
| **Ctrl+U** | Deletes from the start of the line to the cursor (on a one-line draft with the cursor at the end, that clears it). |
| **Ctrl+K** | Deletes from the cursor to the end of the line. |
| **Ctrl+R** | Searches the messages you sent in this project (newest first, every word must match). ↑↓ or Ctrl+R again to move, Enter puts the message in the input, Esc cancels. |
| **`!` at the start** | Runs the rest as a shell command yourself (`!npm test`): live output, no approval, and it goes along with your next message. |
| **Ctrl+G** | Opens the draft in your editor (`$VISUAL`, then `$EDITOR`, else `vi`; Notepad on Windows). Save and quit to bring the edited text back. |
| **Ctrl+V** | Pastes an **image** from the clipboard as `[Image #1]`. Normal text paste uses your terminal's paste. |
| **Paste** | Long pastes (more than 3 lines or 800 characters) collapse to `[Pasted text #1 +42 lines]`. |
| **Drag a file onto the terminal** | Attaches it: images as `[Image #n]`, other files as `[File #n: name]`. |

### Suggestions

| Key | What it does |
|---|---|
| **`/`** | Opens the command and skill list, filtered as you type. |
| **`@`** | Opens a fuzzy list of project files. The chosen file's contents go with your message. |
| **↑ / ↓** | Moves through the open list. |
| **Tab** | Inserts the highlighted command (`/name `) or file. |

:::note
↑ and ↓ only drive these lists. They don't recall earlier messages.
:::

## Fullscreen only

### Keys

| Key | What it does |
|---|---|
| **PgUp / PgDn** | Scroll the history by a page. |
| **End** | Jump back to the latest message. |
| **Ctrl+B** | Show or hide the sidebar. It also hides itself in terminals narrower than 96 columns. |

### Mouse

| Action | What it does |
|---|---|
| **Wheel** | Scrolls the history 3 lines per notch (or the open window). |
| **Drag over the history** | Selects text. Releasing copies it, and the footer flashes `✓ Copied 120 characters`. Dragging past the top or bottom edge scrolls. |
| **Click in the history** | Clears the selection. |
| **Click a top-bar segment** | Model → `/model`, account or usage → `/usage`, `ctx` → `/context`, `⏸ plan mode` → turns it off, `◎ goal` → `/goal`, `● N agents` → `/agents`, `● N background` → the shell's logs (or the list, if several are running), `◂ main` → back to the main agent, `[≡]` → sidebar. |
| **Click in the sidebar** | Opens an agent's view, an account's usage, switches to a listed model, or runs the section's action (compact, accounts, configure). |
| **Click a suggestion** | Runs that command, or inserts that file. |
| **Click a button or menu row** | Picks it, in approval prompts, `/login`, `/model`, `/settings` and other windows. |
| **Click `[×]` or outside a window** | Closes the window. |
| **`↓ N lines below` (when scrolled up)** | Click to jump to the latest message. |

Copying uses `pbcopy` on macOS, `clip` on Windows, and `wl-copy`, `xclip` or `xsel` on Linux. Rein also sends OSC 52, so copying works over SSH in terminals that support it. Your terminal's own selection is unavailable while mouse reporting is on. Use Rein's drag-to-select instead, or hold your terminal's override modifier if it has one.

:::tip[Terminal.app]
Turn on **View → Allow Mouse Reporting**, or clicks and the wheel won't reach Rein.
:::

### Windows

Commands like `/usage`, `/help`, `/context` and `/shells` open a centered window while the conversation keeps streaming underneath.

| Key | What it does |
|---|---|
| **Esc** | Closes the window. In info windows **q** and **Enter** close it too. |
| **↑ / ↓**, **PgUp / PgDn**, wheel | Scroll the window's content. |
| **← / →** or **Tab** | Switch sections in `/model`. **← / →** switch tabs in `/settings`. |
| **Enter** | Choose the highlighted row. |
| **k** | In `/agents`: stop the subagent. In `/shells`: kill the command. |

## Prompts and pickers

These work in both renderers.

**Approval prompt** (file change or command):

| Key | Choice |
|---|---|
| `1`, `y` or Enter | Allow once |
| `2` or `a` | Allow for this session (not offered for sensitive paths or in plan mode) |
| `3` | Always allow, saving the suggested rule (shown only when there's a rule to suggest) |
| `4`, `n` or Esc | Deny |

**Plan approval** (`Plan — approve to start`): `1`/Enter save & implement now · `2` save & start as a goal · `3` save only · `4`/Esc keep planning · ↑↓ PgUp PgDn scroll the plan.

**Questions from the agent**: ↑↓ choose · ←→ move between questions · Space toggles an option in multi-select questions · Enter confirms · Esc cancels.

**Rewind**: ↑↓ pick a message · Enter · then pick *Restore code and conversation*, *Restore conversation only* or *Restore code only* · Esc goes back.

**Resume picker**: ↑↓ select · Enter (or click) continue · Esc starts a new conversation.

**Import prompt** (first run): Enter or `y` imports · Esc or `n` skips.

**Login**: Esc cancels a browser sign-in that's waiting. For Claude, paste the code and press Enter.

## Classic renderer

`rein --classic` (or `/tui classic`) prints the conversation inline into your terminal's normal scrollback:

- **No mouse capture.** Scroll and select with your terminal as usual.
- No top bar, sidebar or floating windows. Information commands print into the history, and the status line sits under the input.
- All keys in [Everywhere](#everywhere-fullscreen-and-classic) work. PgUp/PgDn/End and Ctrl+B don't apply.

## Related

- [The terminal UI](../../features/tui/)
- [Slash commands](../commands/)
- [Your first session](../../start/first-session/)
