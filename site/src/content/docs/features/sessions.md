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

## Related

- [The terminal UI](../tui/)
- [Goals](../goals/): long work that keeps going on its own
- [Scheduled jobs](../headless/#scheduled-jobs): runs that start on their own
