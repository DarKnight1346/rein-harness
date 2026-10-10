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

The sidebar on the left lists your chats like a desktop chat app:

- **New chat** starts a one-off chat, with no project. Each gets its own folder (`~/.rein/chats/<date>-<id>/`) for whatever it makes. One-off chats are listed under **Chats**.
- **Open project** opens any folder on the machine as a project, in a dialog like an operating system's File → Open. On the left are quick access (home, Desktop, Documents, Downloads…), your projects, and the drives and volumes. At the top are back, forward, up and an address bar: click a part of the path to go there, or click the empty end to type a path. The folder's contents come with sortable columns (name, date modified, type, size; files are shown dimmed, since you're choosing a folder), a filter, **Hidden** and **New folder**. Double-click a folder to open it; **Open** takes the selected one, or the one you're in.
- Under **Projects**, each project lists its open chats and its saved conversations (the same ones `rein --continue` sees). Click a project's name to collapse or expand it, **+** starts a chat in it, and ⋯ shows its files or **closes** it. Closing takes it off the sidebar and nothing else: its conversations stay saved, and opening the folder again brings them back.
- Hover a chat and click the archive button to **archive** it: it leaves the list (closing it if it's open) and goes under **Archived** at the bottom, where the restore button brings it back. Archiving never deletes a conversation.

A chat runs in its own Rein process, in its project's folder, so several can run at once and keep going when you close the page. Open the same chat on another device and you see it live there too. A chat nobody has looked at for 30 minutes, and that isn't working, is closed (it's saved; open it again from the list).

- **Replies** stream in as Markdown. Each tool call is a row with a status dot (pulsing while it runs); open it to see its output or diff.
- **Approvals** show as a card: **Allow**, **Allow for this session** (not for [sensitive locations](../permissions/#sensitive-locations)) or **Deny**. Questions from the agent (`ask_user`) and plans in plan mode show as cards too.
- Under the message box: the **model** (Auto or any you can use) and **approvals** (Ask before changes, Auto-approve, Allow everything, Plan only).
- **Enter** sends, **Shift+Enter** is a new line, **Esc** or the square button stops the agent. The ⋯ menu compacts the conversation, shows the project's files or closes the chat.
- While the agent works you can keep typing: a message is **queued** (shown above the box, × removes it) and sent when the reply ends, and a command such as `/btw` or `/cost` runs right away, as in the terminal.

### Slash commands

Everything you type goes through the same code as the terminal: messages, [slash commands](../../reference/commands/), skills (yours, the built-in ones, plugins' and marketplace items') and `!command`. Type `/` for the list: the everyday commands first, then fuzzy search over all of them, best match first, the same list and order as the terminal's. **↑ ↓** move, **Tab** or **Enter** fills in the highlighted one, and a command typed out in full runs.

What a command prints shows in the thread under `› /command`, and `/usage` and `/context` draw their bars. These open a window instead:

| Command | In the web UI |
|---|---|
| `/settings [tab]` | Every tab of the terminal's: Status line and Sidebar (check to show, arrows to reorder), General, Agents, Accounts, Safety, and Advanced with every key in `config.json` (searchable; empty means the default) |
| `/model` | Every section (Chat model, Subagents, Subagent priority, Decision model, Compaction model, Advisor, Web) and the chat model's effort |
| `/goal:plan` | The unfinished plans in `.rein/plans/`, to start one as a goal |
| `/rewind` | Your messages, newest first: pick one, then restore code and conversation, the conversation only, or the code only. The message comes back into the box to edit and resend |
| `/shells`, `/shell <id>` | The commands you and the agent started, with their status; open one for its output (it follows a running command) and **Stop it** |
| `/agents` | The conversation's subagents: open one to follow what it does, message it, or **Stop** it (clicking one in the sidebar opens this too) |
| `/mcp` | The MCP servers and their state, each with what to do: approve a project server, accept a changed one, sign in (the server's OAuth page; it returns to the computer Rein runs on, so finish it in a browser there), or reconnect |
| `/marketplace` | The store, as in the terminal: categories, search, each item's page (what it adds, its README, a warning when it runs code), **Install**, **Update**, **Uninstall**, **Refresh**, and the marketplaces themselves (add a repo, remove one; the official one stays) |
| `/marketplace update` | The items with updates: **All** or any of them |
| `/goal` | The goal, its plan's milestones, and the checks so far, with Pause, Resume and Clear |
| `/btw <question>` | The answer streaming in; it's never added to the conversation |
| `/help` | Every command, marketplace items' commands and every skill, searchable; click one to start typing it |
| `/update` | The update's output as it runs |
| `/vault set NAME` | A hidden field for the value |
| `/login` | The accounts Rein uses and whether each is signed in: re-authenticate or remove one, add any kind (Claude subscription or Console API key, Claude on Bedrock or Vertex, Codex with ChatGPT or an OpenAI API key), and the Jev key. See [Signing in from the browser](#signing-in-from-the-browser) |

The **Settings** page (bottom left) opens the same settings and model windows for the chat you're in.

A few commands are for the terminal, and say what to use instead:

| Command | Instead |
|---|---|
| `/resume` | Open a conversation from the list on the left |
| `/tui`, `/voice`, `/remote`, `/exit` | Terminal features (close a chat from the list) |

### Signing in from the browser

`/login` signs accounts in through the official `claude` and `codex` CLIs on the computer Rein runs on, as the terminal does. Rein never sees the tokens: the CLIs keep them. Both work from any device, not only the one Rein runs on:

- **Claude:** **Sign in** opens Anthropic's page. After you sign in it shows a code; paste it into the window.
- **Codex with ChatGPT:** Rein asks Codex for a **device code** and shows it with a link to OpenAI's page. Open the link on any device, sign in, and enter the code. (The terminal's ChatGPT login ends in a callback to `localhost` on Rein's machine, which a phone can't reach; the device code doesn't need it.) It needs a Codex with the device-code login; an older one says to update Codex or sign in from a terminal.
- **API keys** (Anthropic Console, OpenAI) and the **Jev** key go into a hidden field. **Bedrock** and **Vertex** use the AWS or Google Cloud credentials already on the machine; the window asks for the region and profile or project and checks them.

A new account is used by new chats right away; a chat that's already open picks it up when its model list next refreshes.

### Previews

When the agent starts a web server, or shows you a VM, an emulator or a desktop app, you see it live beside the conversation, from any device: the page streams from a browser on the machine Rein runs on, so `localhost` works. See [Previews](../previews/).

### Marketplace items

Items you install from the [marketplace](../marketplace/) work in the web UI as in the terminal: their commands are in the `/` list and `/help`, their skills too, and what their code draws shows up here, with the same terminal colors: sidebar sections in the right sidebar, status segments in the status line. A theme item colors the page's accent (as does `theme.accent` in your settings), and uninstalling it brings back the one you had.

### Status line and sidebar

Above the thread is the **status line**: the segments you chose in `/settings` → Status line (model, account, usage, context, decision model, messages, advisor, approvals), then the segments of [marketplace items](../marketplace/) you installed. Click one for its command (`/model`, `/usage`, `/context`).

On the right is the **sidebar**: the goal's plan and the task list while there are any, then the sections you chose in `/settings` → Sidebar (agents, accounts with their usage bars, chat model, context, auto routing, session, shortcuts), then items' sections. Click a model to switch to it, an account for `/usage`. The ▯ button at the top hides or shows it; on a narrow screen (a phone) it slides over the chat when you open it.

Both follow the conversation as it goes, and change as soon as you change their layout.

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
