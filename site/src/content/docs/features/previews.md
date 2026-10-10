---
title: Previews
description: See what the agent builds, live, from wherever you are. Web apps stream from a browser on the machine Rein runs on, so localhost works as-is; VMs, emulators and desktop apps stream over VNC.
---

When the agent builds something you need to look at, a web app, an OS in QEMU, an app in an emulator, you shouldn't have to be at the machine Rein runs on to see it. Previews bring it to you in the [web UI](../web-ui/), live, with your clicks and keys going back to it.

## Web apps

When a command prints a local URL, as a dev server does when it's up (`Local: http://localhost:5173/`), the URL shows up as a chip above the message box. Click it to open the preview beside the conversation.

The page is shown by a headless Chrome running on the same machine as the server, streamed to you, so:

- `localhost` works as-is. You can be on a phone and still see the app on `localhost:5173`.
- An app that calls its own API on another port (a UI on 5173, an API on 3001) works too: the browser making those calls is next to both servers.
- Hot reload, websockets and absolute paths work, because nothing is rewritten.

The preview has back, forward, reload and an address bar. Click, scroll and type in it as in a browser; paste goes in as typing. It lays out at the size of the pane, so a narrow pane shows the app's mobile layout.

A preview found in a command's output goes away when that command ends.

:::note[Needs a browser on the machine]
Rein uses Chrome, Chromium, Edge or Brave, whichever it finds, or the one in `REIN_BROWSER`. Each preview gets a fresh profile in a temporary folder, never yours, and the folder is removed when the preview closes. Without a browser, opening a web preview says so.
:::

## Anything with a screen: VNC

For a VM, an emulator or a desktop app, Rein shows a VNC display. Rein itself speaks VNC and sends the screen to the page, so nothing else needs installing in the browser.

| What you're building | How it gets a display |
|---|---|
| An OS or anything in QEMU | `qemu-system-x86_64 … -vnc :1`, then preview `:1` |
| A desktop app on a headless Linux machine | Run it in a virtual display (`Xvfb :99`, then `DISPLAY=:99 your-app`) and share it with `x11vnc -display :99 -rfbport 5999 -nopw`, then preview `localhost:5999` |
| An Android app | The emulator in a virtual display as above (`-no-window` has no screen to share) |
| A whole desktop | Its screen sharing (macOS Screen Sharing, a VNC server on Linux or Windows) |

Click into the screen and type: keys, the mouse and the wheel go to it. Raw and CopyRect updates are supported; a server that asks for a VNC password isn't yet, so start it without one (QEMU's `-vnc :1` has none).

## How a preview starts

- **On its own:** any local URL in a command's output, from the agent's commands or your `!` commands.
- **The agent shows you:** in the web UI the agent has a [`preview`](../../reference/tools/#preview) tool. It uses it to open a web app (`url`) or a display (`vnc`) for you when there's something to look at.
- **You:** **+ Preview** above the message box, or [`/preview`](../../reference/commands/) with a URL or a display (`/preview localhost:3000`, `/preview :1`).

`/preview` lists them all; `/preview <n>` opens one. In the terminal, `/preview <n>` opens a web preview in your own browser and a display in your VNC viewer (macOS opens `vnc://` addresses in Screen Sharing).

## Not yet

These are on the [roadmap](../../start/whats-new/): an Android emulator streamed without a virtual display (over `adb`), the iOS Simulator (view only: it has no input API), and capturing a native window on macOS or Windows.

## Security

- The page only ever opens a preview Rein registered, by its number. It never sends an address Rein then connects to, so a preview can't be used to reach other services on the machine.
- The streamed browser only goes to `http(s)` pages. `file://`, `chrome://` and other internal pages are refused, and a page's dialogs are dismissed (their text is shown in the chat).
- A preview runs as the account Rein runs as. Clicking and typing into one, especially a VM's or a desktop's screen, is as powerful as a shell on that machine. Treat access to the web UI accordingly ([Security](../../project/security/#the-web-ui)).

## Related

- [Web UI](../web-ui/)
- [Tools reference: `preview`](../../reference/tools/#preview)
