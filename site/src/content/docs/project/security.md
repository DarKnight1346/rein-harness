---
title: Security
description: Rein's security model (official CLIs only, no token access, project confinement, approvals, a locked-down Codex sandbox), its honest limitations, and how to report a vulnerability.
---

Rein puts an AI agent with file and shell tools in your terminal, signed in to your subscriptions. This page explains what protects you, where the edges are, and how to report a problem.

## The model in one paragraph

All model traffic goes through the **official `claude` and `codex` binaries**, signed in the normal way. Rein never reads, copies or stores their OAuth tokens. Neither CLI runs a single one of its own tools: every file read, edit and shell command is one of **Rein's tools**, executed in the Rein process by one host (`src/tools/host.ts`). That host is the single place where confinement, permission rules, hooks, approvals and checkpoints are enforced, for every provider and every subagent.

## Official CLIs, no tokens

- **Accounts are CLI homes.** A Rein-added account is a separate `CLAUDE_CONFIG_DIR` or `CODEX_HOME` under `~/.rein/accounts/<provider>/<id>/` (created `0700`). Imported logins are used in place and never logged out by Rein. Logging in runs `claude auth login` / Codex's own ChatGPT flow. See [Accounts](../../features/accounts/).
- **No token handling.** Rein never opens the credential files or the Keychain entries the CLIs use. Usage numbers come from what the CLIs report (`rate_limit_event` on Claude, `account/rateLimits/read` on Codex). See [Drivers](../../internals/drivers/).
- **Env hygiene.** Before spawning a CLI, `src/providers/env.ts` removes variables that would override the account's own login: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` for Claude; `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_HOME` for Codex. The home variable is then set only for Rein-owned accounts. Every request is billed to the subscription you picked, never to a stray API key.
- **Codex login is ChatGPT only.** `account/read` must report `type: "chatgpt"`. Anything else shows `unsupported auth type: …`.

## Built-in tools are off

**Claude** runs with `--tools ""` (no built-in tools), `--strict-mcp-config` with only Rein's own MCP proxy (so claude.ai connectors can't leak in), `--allowedTools mcp__rein__…`, `--setting-sources ""` and `--disable-slash-commands`.

**Codex** gets a rewritten model catalog that nulls the tool fields (`tool_mode`, `apply_patch_tool_type`, `shell_type: "disabled"`, `multi_agent_version`…), plus `--disable` for 21 features. Defense in depth on top of that: every thread starts with `sandbox: "read-only"` and `approvalPolicy: "untrusted"`, and **Rein declines every approval request** Codex sends. If a future model slipped a built-in tool past the catalog, it would become an approval request that gets declined, not a command that runs.

## Project confinement

File tools (`read`, `list`, `write`, `edit`, `delete`, `search`, `image_generate`) work inside the **working directories**: the project folder you started Rein in, this session's scratchpad (`~/.rein/scratch/<id>/`), `~/.rein/skills`, `additionalDirectories` from config, and folders added with `/add-dir` or `--add-dir`. Any other path needs your approval first (see [Permissions](../../features/permissions/)).

- **Symlink-safe resolution.** Paths are resolved with `realpath` on the nearest existing ancestor (`resolvePath` in `src/tools/fs.ts`), so `link → /etc` can't be used to escape.
- **No following swapped symlinks.** Files are opened with `O_NOFOLLOW` after the check. If a background process swapped a file for a symlink in between, the tool refuses.
- **Safe temp files.** Large edits write to an unpredictable temp name created exclusively (`wx`), so a pre-planted file or symlink can't be written through.
- **Stale-file protection.** Changing an existing file requires that the agent read it in this conversation and that it hasn't changed since.
- `delete` refuses to delete the project root.

### Sensitive paths

Outside the working directories, credentials and secrets get stricter treatment (`isSensitivePath` in `src/tools/host.ts`): `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, `~/.pypirc`, `~/Library/Keychains`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.rein/accounts`, `~/.rein/accounts.json`, Rein's `secrets/` folder (the vault, the Jev key), plus any `.env*` file and `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keychain`. These are **asked about one at a time, even in bypass mode**. There's no "allow for the session" or "always allow" option, and auto mode never approves them.

## Approvals

Every mutating tool call (writes, edits, deletes, shell commands, MCP adds and removes, image generation into the project, MCP server tools not marked `readOnlyHint`) goes through the pipeline in `ToolHost.call()`:

1. **Permission rules.** `deny` rules block, `allow` rules skip the prompt. Rules are read from six settings files, including Claude Code's (see [Files](../../reference/files/)).
2. **PreToolUse hooks** may block, approve, or force the prompt.
3. **Read-only shell commands** (`ls`, `cat`, `git status`, `npm ls`, `--version`…) run without asking, unless they name a path outside the working directories. Compound commands are split and every part must qualify. Anything with `$(…)`, backticks or process substitution never qualifies.
4. **Plan mode** refuses file changes. A shell command not on the read-only list goes to the decision model, then to you.
5. **Outside paths** ask about access first.
6. **Scratchpad** writes don't ask.
7. **Approval mode** (`/settings` → General → Approvals): `ask` (default), `auto` (the decision model allows at p ≥ 0.85 and otherwise asks you; it never auto-denies), or `bypass`.
8. A **checkpoint** is taken before any file change, for [/rewind](../../features/rewind/).

`mcp_add` always asks, even with "allow for the session" on, because it runs a command or contacts a URL. Project `.mcp.json` servers need a one-time approval before they connect.

## Web fetching

`web_fetch` (`src/tools/web.ts`) upgrades `http` to `https`, refuses non-HTTP schemes and URLs with credentials, and refuses local and private hosts: `localhost`, `*.localhost`, `*.local`, `*.internal`, dotless names, and loopback, private, link-local and CGNAT IP literals (IPv4 and IPv6). Redirects are followed only on the same host. A cross-host redirect is reported back to the agent instead of followed. Bodies are capped at 10 MB, requests at 30 s.

## The web UI

`rein --ui` only listens on this computer unless you set it up with a username and password, and setup itself needs a one-time code printed where Rein started. Without a login it only answers to `localhost` (and your Tailscale name in Tailscale mode), so other sites can't reach it through DNS rebinding; every change needs a header other sites can't send. Passwords are scrypt hashes, sessions are hashed, failed sign-ins are rate-limited, and the page runs under a strict content security policy. A signed-in user can do what the account running Rein can do, files included: treat it like a shell on that machine. See [Web UI](../../features/web-ui/#security).

## Honest limitations

These are real, and you should know them:

- **The sandbox limits writes, not reads.** By default the agent's commands run in an OS sandbox that confines writes to the project, scratchpad, temp folders and package caches (see [the command sandbox](../../features/permissions/#the-command-sandbox)), but they can read anything you can, with your full environment (including API keys in it), and the network is open unless you choose strict mode. Windows, and Linux without bubblewrap, have no OS sandbox; the [container sandbox](../../features/system/#a-container-per-task) works wherever Docker or Podman runs, and limits reads and the network too.
- **Read-only commands auto-run.** The allowlist is conservative, but a command it matches runs without asking.
- **Private-host blocking is by hostname.** `web_fetch` checks the literal host and IP; it doesn't resolve DNS. A public name that resolves to a private address isn't blocked.
- **Sensitive-path rules apply outside the project only.** A `.env` inside your project is an ordinary project file the agent can read and edit like any other.
- **Bypass is bypass.** In bypass mode, writes outside the working directories are allowed without asking, except sensitive paths.
- **Project hooks need your trust once.** Hooks a repository ships run only after you trust them (and again after any change), but once trusted they run with your permissions on every event. See [Hooks](../../features/hooks/#trusting-a-projects-hooks).
- **Project allow rules aren't gated.** A cloned repo's `.claude/settings.json` or `.rein/settings.json` can ship `permissions.allow` rules, which apply without a trust prompt. Read them before you start.
- **Memory writes don't ask.** `remember` and `forget` edit `.rein/MEMORY.md` in the project without approval.
- **Windows has no `O_NOFOLLOW`.** Rein checks for a symlink explicitly instead, which leaves a tiny race window.
- **The [secrets vault](../../features/vault/) masks, it doesn't sandbox.** Values never reach the model, but a command the agent runs can still send one to a server; review commands that contact unexpected hosts. Masking recognizes the value as is and in common encodings (base64, hex, URL, JSON), not arbitrary transformations.
- **The Jev key and vault briefly appear in a process argument list** while it's saved to the macOS Keychain (`security add-generic-password`).
- **Jev sees excerpts.** With Jev as the decision model, the minimal state for each decision (message head and tail, the action and a change preview, goal evidence excerpts) is sent to typesafe.ai. Use `cheapest` to keep decisions on your own accounts. See [Decision model](../../internals/decision-model/).
- **Transcripts are plaintext.** `~/.rein/sessions/` holds your messages and tool-result excerpts, written `0600` in a `0700` folder.
- **MCP servers are your code.** A stdio server runs with your environment, and an HTTP one sees what you send it. Adding one always asks, but a malicious server is out of scope.

## Planted instructions and data leaving the machine

Optional guards vet new dependencies (`depCheck`, which looks packages up on their registries and OSV), catch instructions planted in web pages and MCP results (`injectionScan`) and make network calls your decision once private data and outside content are both in a conversation (`exfilGuard`). See [Safety guards](../../features/safety/).

## API keys in CI

Rein removes API keys from the environment it gives each CLI, so every account uses its own login. The one exception is `REIN_ENV_KEYS=1` (set by the GitHub Action and the GitLab component): a one-run account that uses `ANTHROPIC_API_KEY` from the environment through the official `claude` CLI, never saved to disk.

## Secret scanning

With `secretScan` set to `warn` or `block`, Rein checks each change the agent makes for credentials it would add to a file, and masks them in saved conversations. See [Secret scanning](../../features/permissions/#secret-scanning).

## Telemetry

Rein sends no telemetry of its own. If you turn on [OpenTelemetry export](../../features/observability/), it goes only to the endpoint you set, and carries metadata (model and tool names, timings, outcomes, token counts, cost), never prompts, code, file names or commands.

## Remote access

The [remote page](../../features/remote/) (`/remote`) lets a paired device do what the keyboard can: message the agent and answer its approvals.

- **Only this computer by default.** It listens on `127.0.0.1`. Reach it through a private tunnel (Tailscale, Cloudflare Tunnel), which also provides HTTPS. Listening on a network address (`remoteHost`) is plain HTTP, and Rein says so when it starts.
- **Pairing:** a 6-digit code, single use, valid 5 minutes, locked after 5 wrong tries, rate-limited. It becomes a random 256-bit token, compared in constant time and kept in memory only.
- **Requests:** reads need the token as an `HttpOnly`, `SameSite=Strict` cookie; changes also need it as a header, so a cross-site request can't act on the page. The page has a strict CSP and never renders conversation text as HTML.
- **Not protected against:** someone who has a paired device, or the token. That's the same as someone at your keyboard. `/remote unpair` revokes every device and `/remote off` stops the page.
## Issue trackers

An [issue tracker](../../features/trackers/) hands Rein text written by whoever can open or edit the issue: a prompt-injection channel by design. Rein's defences:

- **Every action asks**, regardless of approval mode (`untrusted` origins in `src/tools/host.ts`).
- The issue text is wrapped as untrusted, and the issue can't close the wrapper early. The agent is told not to run commands from it unchecked, not to reveal secrets, and not to push, publish or open pull requests.
- The work happens on a **new branch in a separate worktree**. Nothing is merged into your tree or pushed. The report goes to the issue, never into your conversation.
- Tracker tokens are vault secrets, masked like any other. GitHub goes through `gh`, so Rein never handles that token.

What this doesn't stop: you approving a harmful action. Read the approval before you allow it, especially commands that contact other hosts.

## Your accounts, your responsibility

Rein drives your own subscriptions through the providers' official CLIs. It doesn't proxy, share or pool access between people. Whether running several accounts of the same provider fits that provider's terms is your call. Check the terms of each subscription you use.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately on GitHub: **Security → Report a vulnerability** on the repository ([direct link](https://github.com/DarKnight1346/rein-harness/security/advisories/new)).

Include what you found, how to reproduce it, and your Rein version (`rein --version`). You'll get a reply within a few days. Fixes ship as a new npm release, and the advisory is published once users can update.

Only the latest npm release is supported. Rein updates itself on launch, and `rein --update` installs the newest version.

Reports that matter most: anything that lets a model, a web page or a pasted file **escape the project folder**, **run commands without the configured approval**, **reach local or private network hosts through `web_fetch`**, or **expose account credentials, the Jev API key or a vault secret to the model**.

## Related

- [Permissions](../../features/permissions/)
- [Drivers](../../internals/drivers/)
- [Files & directories](../../reference/files/)
- [FAQ & troubleshooting](../faq/)
