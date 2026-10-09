---
title: MCP
description: Connect Model Context Protocol servers to every model in Rein — reuse your Claude Code config, let the agent add servers itself, and keep project servers behind an approval.
---

Rein is an MCP client. Servers you already set up for Claude Code work as they are, their tools are offered to **every** model (Codex included), and each call goes through the same permission rules and prompts as Rein's own tools. You can also skip the config file and ask the agent to add a server.

```text title="rein"
› add the GitHub MCP server for this project, token is in $GITHUB_TOKEN

Rein wants to McpAdd github → npx -y @modelcontextprotocol/server-github

Run MCP server "github":
$ npx -y @modelcontextprotocol/server-github
(env: GITHUB_TOKEN)
saved to .mcp.json

[1 Allow]  [2 Allow all changes & commands this session]
[3 Always allow mcp_add (this project)]  [4 Deny]

⏺ McpAdd(github → npx -y @modelcontextprotocol/server-github) · you approved
  Saved to ~/code/app/.mcp.json.
  github — connected · stdio: npx -y @modelcontextprotocol/server-github · from .mcp.json (project)
```

## Where servers come from

Rein reads three places, in Claude Code's format. When two define the same name, **the first one wins**:

| # | File | Trust |
|---|---|---|
| 1 | `<project>/.mcp.json` | The repo's shared servers. **Each needs your approval once.** |
| 2 | `~/.rein/mcp.json` | Your own servers, for every project. Trusted. |
| 3 | `~/.claude.json` | Servers added with `claude mcp add`, both user scope and this project's scope. Trusted. |

```json title=".mcp.json"
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}
    },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {"Authorization": "Bearer ${DOCS_TOKEN:-}"}
    }
  }
}
```

### Project server approval

A repository shouldn't be able to make Rein launch a program because you opened it. So servers from a project's `.mcp.json` start in the `needs-approval` state, and nothing runs until you approve each one in [`/mcp`](#the-mcp-screen). Rein points them out shortly after launch:

```text title="rein"
This project's .mcp.json has MCP server waiting for your approval: docs — /mcp to review.
```

Approvals are stored as `enabledMcpjsonServers` in `<project>/.rein/settings.local.json`. Approvals you already gave in Claude Code (`.claude/settings.local.json`) count too.

Approval is by **name**. If the repo later changes what `github` runs, the approval still applies, so check `.mcp.json` changes when you pull.

### Environment variables

`${VAR}` and `${VAR:-default}` are expanded in every string of a server's config (command, args, env, url, headers) from Rein's environment, as in Claude Code. An unset variable with no default becomes an empty string. Keep secrets in your environment and reference them; don't paste them into `.mcp.json`.

Expansion applies to project `.mcp.json` files too, which is one more reason to look at a repo's server config before approving it.

## Transports

| Config | Transport |
|---|---|
| `{"command": "...", "args": [...], "env": {...}}` | **stdio**. Rein launches the program in the project root with your environment plus `env`. Its stderr is discarded. |
| `{"type": "http", "url": "...", "headers": {...}}` | **Streamable HTTP** |
| `{"type": "sse", "url": "...", "headers": {...}}` | **SSE** |

Servers connect in the background at startup, with a 30-second connect timeout. Their tools appear as each one comes up, and if a server sends `tools/list_changed`, its tool list refreshes on the fly.

## Signing in to remote servers (OAuth)

Hosted MCP servers such as Linear, Notion, Atlassian, Sentry and GitHub's remote server sign you in with OAuth. Add one by URL, with no token needed:

```json title="~/.rein/mcp.json"
{"mcpServers": {"linear": {"type": "http", "url": "https://mcp.linear.app/mcp"}}}
```

1. Rein connects, sees the server wants a sign-in, and shows it as **sign in** (a yellow dot) in [`/mcp`](#the-mcp-screen). On launch it also mentions which servers need one. It never opens a browser on its own.
2. In `/mcp`, press **Enter** on the server. Your browser opens the server's login and consent page; the URL is also shown in case it didn't open.
3. After you approve, the browser comes back to a one-off page on `127.0.0.1` ("Signed in — you can close this tab"), and the server connects with its tools.

Under the hood this is the MCP authorization flow, handled by the MCP SDK: dynamic client registration, authorization code with PKCE, and a loopback redirect. Tokens and the client registration are stored per server URL in `~/.rein/mcp-auth/`, readable only by you, and refreshed automatically. Later launches reconnect without signing in again.

- A server whose config already sends an `Authorization` header (as in the example above) uses that header and never asks to sign in.
- Servers you signed into with Claude Code (`claude mcp add`) need one sign-in in Rein too: Claude Code keeps its tokens to itself.

## Tool names

Server tools appear to the model as `mcp__<server>__<tool>`, the same naming Claude Code uses, so permission rules and hook matchers you wrote for Claude Code carry over. Characters outside `A–Z a–z 0–9 _ -` become `_`. Names longer than 50 characters are shortened and given a 6-character hash, which keeps them within provider limits once Claude's `mcp__rein__` prefix is added.

In the transcript they read as `server:tool`:

```text title="rein"
⏺ github:search_issues({"query":"is:open label:bug"})
```

Results are capped at 60,000 characters. Text, images (passed to the model as images), embedded resources, resource links and `structuredContent` are all handled.

## Approvals and `readOnlyHint`

An MCP tool is treated as **mutating**, and goes through your [approval mode](../permissions/#approval-modes), unless the server marks it with the `readOnlyHint: true` annotation. Only tools that declare themselves read-only skip the prompt.

Saved rules work on MCP tools:

```json title=".rein/settings.json"
{
  "permissions": {
    "allow": ["mcp__github__search_issues", "mcp__github__get_issue"],
    "deny": ["mcp__prod-db"]
  }
}
```

`mcp__github` covers every tool of that server; `mcp__github__create_issue` covers one.

:::note
`readOnlyHint` is the server's own claim. A server you don't trust can mislabel a tool, so add a deny rule for any server tools you want blocked regardless.
:::

## Sampling: servers can use your models

Some MCP servers need a model themselves: to summarize what they fetched, classify an issue, or draft a reply. The protocol lets them ask the client for one (**sampling**, `sampling/createMessage`). Rein answers with **your signed-in subscriptions**, so a server like that needs no API key of its own.

- **Which model:** a model the server hints at (`"haiku"`, `"claude"`, `"gpt"`) when you have it. Otherwise the server's priorities decide: when it values intelligence most, your chat model (or the default); when it values cost or speed, the cheapest model you have.
- **You approve it.** The first request from each server shows its prompt:

  ```text title="rein"
  Rein wants to use a model (Haiku 4.5) for the MCP server "test"
  ```

  `1 Allow` answers this request; `2 Allow "test" to use models this session` stops asking for that server until Rein exits; `4 Deny` refuses, and the server gets an error.
- **Headless** (`rein -p`) has no one to ask, so requests are refused unless sampling is set to allow.
- `mcpSampling` in `config.json`: `"ask"` (default), `"allow"` (no prompt), or `"off"` (Rein doesn't offer sampling to servers at all).

Text only: images in a server's request are left out. The usage counts against the account the model ran on, like any other request.

## Agent-managed servers

The agent can manage servers itself, so "connect the Postgres MCP server" is a complete request:

| Tool | What it does |
|---|---|
| `mcp_list` | Every server with status, transport, source file and tool names. |
| `mcp_add` | Saves a server and connects to it. stdio takes `command`, `args`, `env`; remote takes `url`, `transport` (`http` by default, or `sse`) and `headers`. |
| `mcp_remove` | Removes a server from `.mcp.json` or `~/.rein/mcp.json` and disconnects it. Servers from `~/.claude.json` must be removed with `claude mcp remove <name>`. |
| `mcp_call` | Calls a server's tool **in the same turn**, right after `mcp_add`. New tools otherwise reach the model on its next message. The inner call gets the tool's own approval and permission rules. |

**Scopes:** `mcp_add` saves to `project` by default, meaning `<project>/.mcp.json`, shared with the repo. Because you approved the call that showed the command, the server is also marked approved for you. `user` saves to `~/.rein/mcp.json` for every project. Server names are 1–40 letters, digits, `-` or `_`.

**`mcp_add` always shows you the command** (or the URL and header names) and where it'll be saved. In `ask` and `auto` modes it always prompts: the auto-approver never handles it, and "allow for this session" doesn't cover it. It's still subject to the usual overrides, though:

- **Bypass mode** runs `mcp_add` without asking.
- An **allow rule** (`"allow": ["mcp_add"]`) runs it without asking.

`mcp_remove` is an ordinary mutating tool: it follows your approval mode, including session allows and auto.

:::caution
`mcp_add` launches whatever command it saves. If you run bypass mode and want a human to see every new server, add `"deny": ["mcp_add"]` and manage servers by hand.
:::

## The /mcp screen

With [`mcpPinning`](../safety/#changed-mcp-servers-mcppinning) on, a server whose config or tools changed since you first used it shows as `changed`, with its tools held; `Enter` accepts it as it is now.


`/mcp` lists every server with a status dot, its tool count or state, transport and source:

```text title="rein"
❯ ● github           12 tools · stdio · .mcp.json
  ● docs             needs-approval · http · .mcp.json
  ● sentry           failed · stdio · ~/.rein/mcp.json · timed out connecting

enter: approve this project server (runs its command) · esc close
```

- **Green** = connected, **yellow** = connecting or needs approval, **red** = failed.
- **Enter** on a `needs-approval` server approves and starts it. On any other server it reconnects, which is handy after you fix a config or restart a server.
- **Esc** or `q` closes the screen. Rows are clickable.

## Related

- [Permissions](../permissions/): rules and approval modes
- [Hooks](../hooks/): matchers work on `mcp__…` names
- [Tools](../tools/)
- [Files reference](../../reference/files/): where `.mcp.json` and `~/.rein/mcp.json` live
- [Coming from Claude Code](../../start/from-claude-code/)
