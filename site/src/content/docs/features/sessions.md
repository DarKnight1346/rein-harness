---
title: Background sessions
description: Sessions that keep running after you close the terminal, and that you can reattach to from any terminal.
---

A long goal shouldn't depend on a terminal tab staying open. Start Rein in the background and the session lives on its own. You can close the window, log out of the SSH session, or switch machines over SSH, and attach again later.

## Start one, leave, come back

```sh
rein --background          # Rein as usual, in a background host
```

It looks and works like `rein`. To leave it running, close the terminal or press **Ctrl+\\**:

```text
Detached: the session keeps running. rein attach 3f9a21c0 comes back to it.
```

From any terminal on the same machine:

```sh
rein attach                # this folder's background session (or the only one)
rein attach 3f9a21c0       # a particular one; a prefix of the id is enough
```

You get the same screen back, as it is now, and carry on. `rein --background` takes the usual flags (`-c` to continue a conversation, `--add-dir`, `--scope`…).

## How it works

`rein --background` starts a small **host** process, detached from the terminal. The host runs Rein in a pseudo-terminal and listens on a local socket that only your user can open (a named pipe on Windows). `rein attach` connects a terminal to it: your keys go to Rein, Rein's screen comes to you, and a resize makes it redraw for your terminal.

Here's what to expect:

- **One terminal at a time.** Attaching from a second terminal takes the session over from the first.
- **The screen comes back.** The host keeps the last 256 KB of output, so the classic renderer gets its scrollback back too.
- **It ends with Rein.** When Rein inside exits (`/exit`, or it's stopped), the host goes with it, and an attached terminal says *The session ended.*
- **Same machine.** Sessions are local to the machine they run on. To work from elsewhere, SSH in and `rein attach`.

Background sessions need `node-pty`, the same optional package interactive shell commands use. It's installed with Rein on macOS, Linux and Windows. Without it, `rein --background` says so.

## Every session at a glance

With several sessions going (a goal in one repo, a review in another, a background job), `rein sessions` shows all of them:

```text
Rein sessions on this machine

❯ waiting for you ~/code/shop/api   Split the users table  ◎ users split, tests green  [background 3f9a21c0]  (4s ago)  pid 41022
  working         ~/code/shop/web   Move checkout to the new API  (1s ago)  pid 40871
  idle            ~/code/billing    Why is the invoice total off by a cent?  (12m ago)  pid 39310

↑↓ pick · enter attach · m message · k stop · q quit
```

It lists every Rein running on this machine, with these details:

- **State:** idle, working, or **waiting for you** (an approval, a question, a plan to approve).
- **Where:** its folder and the conversation's first message.
- **What it's doing:** the active goal, and whether it's a background session.

Here's what you can do from it:

- **Enter** attaches to a background session. When you detach (`Ctrl+\`), you're back at the dashboard.
- **m** sends the selected session a message. It arrives as if you'd typed it there, and is queued if that session is busy. This works for every session, background or not.
- **k** stops a session, after you confirm with `y`.

Inside Rein, `/sessions` lists the others, and `/sessions send <pid> <message>` sends one a message.

Each running Rein keeps a small status file in `~/.rein/live/` while it runs, and watches an inbox file next to it for messages. Both go away when it exits. Only background sessions can be attached to. A Rein running in an ordinary terminal belongs to that terminal, but it still shows up and takes messages.

## Related

- [The terminal UI](../tui/)
- [Goals](../goals/): long work that keeps going on its own
- [Scheduled jobs](../headless/#scheduled-jobs): runs that start on their own
