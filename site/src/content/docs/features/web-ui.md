---
title: Web UI
description: Rein in the browser on any of your devices, with chats in your projects, approvals and a full file manager, run locally, over Tailscale or on your own server.
---

`rein --ui` serves Rein as a web app: chats in any folder on the machine, the agent's tool calls and diffs as they happen, approvals and questions as cards, and a file manager for the whole machine (handy when Rein runs on a headless server). It works on a phone too.

```sh
rein --ui                 # http://localhost:9333
rein --ui --port 8080     # another port
rein --ui --host 0.0.0.0  # listen on another address
```

The web UI uses the same accounts, models, settings, tools and approvals as the terminal, through the same official `claude` and `codex` CLIs. Add accounts in the terminal (`rein`, then `/login`).

## First run

The first time, Rein prints a one-time **setup code** and a link with it:

```text
Rein web UI: http://localhost:9333
First run: open http://localhost:9333/?setup=Xk2… to set it up (setup code Xk2…).
```

Until setup is done, only the setup page answers, and it needs that code, so whoever reaches the page first can't claim the server. The code is also kept in `~/.rein/webui-setup-code` until setup is done. Then you choose how the web UI is reached:

| Choice | Login | Listens on | For |
|---|---|---|---|
| **Only this computer** | none | `127.0.0.1` | Using it on the machine Rein runs on |
| **My devices, through Tailscale** | none | `127.0.0.1` | Your phone and laptops, over your private tailnet. Setup can run `tailscale serve --bg <port>` for you (Tailscale installed and signed in) |
| **With a username and password** | yes | `0.0.0.0` (your network) | A server of your own. Rein asks everyone to sign in |

To change your choice later, delete `~/.rein/webui.json` and restart `rein --ui`: setup runs again.

:::caution[Password mode and HTTPS]
With a username and password, put HTTPS in front of the web UI, either a reverse proxy (Caddy, nginx) or a `tls` entry in `~/.rein/webui.json`: `"tls": {"cert": "/path/cert.pem", "key": "/path/key.pem"}`. Without it, the password travels unencrypted.
:::

## Chats

The sidebar shows the project you're in, its open chats, and its recent conversations: the same saved conversations you see with `rein --continue`. **New chat** starts one in the project; the project button opens any folder on the machine as a project.

A chat runs in its own Rein process, in its project's folder, so several can run at once and keep going when you close the page. Open the same chat on another device and you see it live there too. A chat nobody has looked at for 30 minutes, and that isn't working, is closed (it's saved; open it again from the list).

- **Replies** stream in as Markdown. Each tool call is a row with a status dot (pulsing while it runs); open it to see its output or diff.
- **Approvals** show as a card: **Allow**, **Allow for this session** (not for [sensitive locations](../permissions/#sensitive-locations)) or **Deny**. Questions from the agent (`ask_user`) and plans in plan mode show as cards too.
- Under the message box: the **model** (Auto or any you can use) and **approvals** (Ask before changes, Auto-approve, Allow everything, Plan only).
- **Enter** sends, **Shift+Enter** is a new line, the square button stops the agent. The ⋯ menu compacts the conversation, shows the project's files or closes the chat.

## Files

**Files** browses any folder on the machine:

- Breadcrumbs, the up button, and a search box (by name, or tick *in files* to search contents, with ripgrep).
- Sort by name, size or date. Tick rows (or Cmd/Ctrl+click) to work on several.
- Double-click a folder to open it, or a file to preview it: text and code open in an editor (**Save** or Cmd/Ctrl+S), images, video, audio and PDFs show as they are, anything else can be downloaded.
- **Upload** (or drop files on the list), **New folder**, **New file**, **New chat here**, and per item (⋯ or right-click): Open as a project, Rename, Move to…, Copy to…, Download, Delete.

A signed-in user can do with files what the account running Rein can do. Deleting asks first and can't be undone; Rein refuses to delete your home folder or a drive's root.

## As a service

`rein service --install` installs the web UI as a service that starts with the system:

| System | What's installed |
|---|---|
| macOS | A launchd agent, `~/Library/LaunchAgents/dev.rein.webui.plist`: starts when you log in, restarts if it stops |
| Linux | A systemd user service, `~/.config/systemd/user/rein-webui.service`. To start it at boot without logging in: `loginctl enable-linger $USER` |
| Windows | A scheduled task, "Rein Web UI", at logon |

```sh
rein service --install              # port 9333
rein service --install --port 8080
rein service --uninstall
```

The service runs the Rein you installed it with, with your `PATH` (so it finds `claude`, `codex` and `git`), and logs to `~/.rein/logs/webui.log`. If the web UI isn't set up yet, `--install` prints the setup link.

## Security

- Without a login, the web UI only answers to `localhost` names (and, in Tailscale mode, your `*.ts.net` name), so a web page elsewhere can't reach it by pointing its own domain at your computer.
- Every change (sending, approving, file operations) needs a header that another site's page can't send, and a matching `Origin`. Session cookies are `HttpOnly` and `SameSite=Strict`.
- Passwords are stored as scrypt hashes, sessions as hashes of their tokens. Five wrong passwords from one address lock it out for 15 minutes.
- The page is plain HTML, CSS and JavaScript from Rein's package with a strict content security policy. Model output is rendered as Markdown with HTML shown as text. Files you preview are served sandboxed and never run as part of the page.

## Related

- [Remote access](../remote/): watching a terminal session from your phone
- [Permissions](../permissions/)
- [Accounts](../accounts/)
