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

The preview has back, forward, reload and an address bar. It lays out at the size of the pane, so on a phone, or in a narrow pane, you see the app's mobile layout.

## On any device

Previews work wherever the web UI does: a phone, a tablet, another computer. The app runs on the machine Rein runs on (a server anywhere, your desktop), and only its screen comes to you.

| | With a mouse and keyboard | On a touch screen |
|---|---|---|
| Click | Click | Tap |
| Scroll | Wheel or trackpad | Swipe (the preview scrolls, not the page) |
| Drag, select | Drag | Press and hold, then drag |
| Right-click | Right-click | Tap with two fingers |
| Type | Click into the preview and type (paste goes in as typing) | The ⌨ button opens your device's keyboard; what you type, Backspace and Enter go to the preview |

These work the same in a web preview and on a display.

A preview found in a command's output goes away when that command ends.

:::note[Needs a browser on the machine]
Rein uses Chrome, Chromium, Edge or Brave, whichever it finds, or the one in `REIN_BROWSER`. Each preview gets a fresh profile in a temporary folder, never yours, and the folder is removed when the preview closes. Without a browser, opening a web preview says so.
:::

## Anything with a screen: VNC

For a VM, an emulator or a desktop app, Rein shows a VNC display. Rein itself speaks VNC and sends the screen to the page, so nothing else needs installing in the browser.

| What you're building | How it gets a display |
|---|---|
| An OS or anything in QEMU | `qemu-system-x86_64 … -vnc :1`, then preview `:1` |
| A native Linux app (desktop or headless server), no VM | The agent asks for a virtual display (the `preview` tool's `app`), Rein starts one and shows it, and the agent starts the app on it (`DISPLAY=:20 your-app &`) with its shell tool, so your approvals apply. Rein uses TigerVNC's `Xvnc` if installed, else `Xvfb` with `x11vnc`, and says what to install if neither is there |
| An Android app | The emulator on a virtual display as above (`-no-window` has no screen to share) |
| A whole desktop | Its screen sharing (macOS Screen Sharing, a VNC server on Linux or Windows) |

Click into the screen and type: keys, the mouse and the wheel go to it. A display with a VNC password asks for it in the pane (the agent can pass it too); it's kept in the chat, never sent to the page. macOS Screen Sharing works with "VNC viewers may control screen with password" turned on (its macOS-account sign-in isn't supported). A virtual display Rein started stops when its preview closes.

## Video with Rein Remote

A native Linux app's virtual display can stream as video instead of frames, with
[Rein Remote](https://github.com/rein-harness/rein-remote) (Rein's own screen protocol). Rein uses it
when the `rein-remote` binary is in `~/.rein/bin` or on your `PATH`:

- The screen goes as H.264, decoded by your browser (with the device's hardware decoder where it has
  one), and only when it changes: a still screen sends almost nothing.
- The cursor is drawn on your device, at your mouse at once, like Remote Desktop: moving it costs no
  video and has no lag.
- Touch works as with frames (tap, swipe to scroll, hold to drag, two-finger tap for a right-click),
  and the keyboard button opens your device's keyboard.
- The pane's address shows **· video** while it streams this way.

With `rein-remote` installed, `Xvfb` alone is enough for a virtual display (`x11vnc` isn't needed,
though Rein starts it too when it's there, for the fallback below). It isn't bundled with Rein yet:
build it from its repository (`cargo build --release -p rr-server`, then copy
`target/release/rein-remote` to `~/.rein/bin/`). Turn it off with
[`/settings reinRemote off`](../../reference/configuration/), or point the setting at a binary.

The stream is a WebSocket on the web UI's own address, after the same sign-in and checks as the rest
of the page; `rein-remote` itself listens on this computer only, behind a token the page never sees.
If the WebSocket can't get through (a reverse proxy that doesn't pass WebSockets, see
[Web UI](../web-ui/#behind-a-reverse-proxy)), the preview falls back to frames by itself.

## Slow links

When your connection is slow (mobile data, a server far away), frames that can't get through are dropped rather than queued, so the preview never falls behind: you see the latest screen, a little less smoothly. Over Tailscale or a domain pointed at your server, previews travel in the same HTTPS connection as the rest of the web UI, so nothing else needs opening.

## How a preview starts

- **On its own:** any local URL in a command's output, from the agent's commands or your `!` commands.
- **The agent shows you:** in the web UI the agent has a [`preview`](../../reference/tools/#preview) tool. It uses it to open a web app (`url`) or a display (`vnc`) for you when there's something to look at.
- **You:** **+ Preview** above the message box, or [`/preview`](../../reference/commands/) with a URL or a display (`/preview localhost:3000`, `/preview :1`).

`/preview` lists them all; `/preview <n>` opens one. In the terminal, `/preview <n>` opens a web preview in your own browser and a display in your VNC viewer (macOS opens `vnc://` addresses in Screen Sharing).

## Not yet

These are on the [roadmap](../../start/whats-new/): native windows on macOS and Windows, Rein Remote video for every preview (web apps, VMs and VNC displays, not only Linux app displays) with hardware encoding (all through [rein-remote](https://github.com/rein-harness/rein-remote)), an Android emulator without a virtual display (over `adb`), and the iOS Simulator (view only: it has no input API).

## Security

- The page only ever opens a preview Rein registered, by its number. It never sends an address Rein then connects to, so a preview can't be used to reach other services on the machine.
- The streamed browser only goes to `http(s)` pages. `file://`, `chrome://` and other internal pages are refused, and a page's dialogs are dismissed (their text is shown in the chat).
- A preview runs as the account Rein runs as. Clicking and typing into one, especially a VM's or a desktop's screen, is as powerful as a shell on that machine. Treat access to the web UI accordingly ([Security](../../project/security/#the-web-ui)).

## Related

- [Web UI](../web-ui/)
- [Tools reference: `preview`](../../reference/tools/#preview)
