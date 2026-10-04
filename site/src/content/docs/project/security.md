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

Outside the working directories, credentials and secrets get stricter treatment (`isSensitivePath` in `src/tools/host.ts`): `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.config/gcloud`, `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, `~/.pypirc`, `~/Library/Keychains`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.rein/accounts`, `~/.rein/accounts.json`, plus any `.env*` file and `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keychain`. These are **asked about one at a time, even in bypass mode**. There's no "allow for the session" or "always allow" option, and auto mode never approves them.

## Approvals

Every mutating tool call (writes, edits, deletes, shell commands, MCP adds and removes, image generation into the project, MCP server tools not marked `readOnlyHint`) goes through the pipeline in `ToolHost.call()`:

1. **Permission rules.** `deny` rules block, `allow` rules skip the prompt. Rules are read from six settings files, including Claude Code's (see [Files](../../reference/files/)).
2. **PreToolUse hooks** may block, approve, or force the prompt.
3. **Read-only shell commands** (`ls`, `cat`, `git status`, `npm ls`, `--version`…) run without asking, unless they name a path outside the working directories. Compound commands are split and every part must qualify. Anything with `$(…)`, backticks or process substitution never qualifies.
4. **Plan mode** refuses file changes. A shell command not on the read-only list goes to the decision model, then to you.
5. **Outside paths** ask about access first.
6. **Scratchpad** writes don't ask.
7. **Approval mode** (`/configure` → Approvals): `ask` (default), `auto` (the decision model allows at p ≥ 0.85 and otherwise asks you; it never auto-denies), or `bypass`.
8. A **checkpoint** is taken before any file change, for [/rewind](../../features/rewind/).

`mcp_add` always asks, even with "allow for the session" on, because it runs a command or contacts a URL. Project `.mcp.json` servers need a one-time approval before they connect.

## Web fetching

`web_fetch` (`src/tools/web.ts`) upgrades `http` to `https`, refuses non-HTTP schemes and URLs with credentials, and refuses local and private hosts: `localhost`, `*.localhost`, `*.local`, `*.internal`, dotless names, and loopback, private, link-local and CGNAT IP literals (IPv4 and IPv6). Redirects are followed only on the same host. A cross-host redirect is reported back to the agent instead of followed. Bodies are capped at 10 MB, requests at 30 s.

## Honest limitations

These are real, and you should know them:

- **The sandbox limits writes, not reads.** By default the agent's commands run in an OS sandbox that confines writes to the project, scratchpad, temp folders and package caches (see [the command sandbox](../../features/permissions/#the-command-sandbox)), but they can read anything you can, with your full environment (including API keys in it), and the network is open unless you choose strict mode. Windows, and Linux without bubblewrap, have no sandbox.
- **Read-only commands auto-run.** The allowlist is conservative, but a command it matches runs without asking.
- **Private-host blocking is by hostname.** `web_fetch` checks the literal host and IP; it doesn't resolve DNS. A public name that resolves to a private address isn't blocked.
- **Sensitive-path rules apply outside the project only.** A `.env` inside your project is an ordinary project file the agent can read and edit like any other.
- **Bypass is bypass.** In bypass mode, writes outside the working directories are allowed without asking, except sensitive paths.
- **Project hooks need your trust once.** Hooks a repository ships run only after you trust them (and again after any change), but once trusted they run with your permissions on every event. See [Hooks](../../features/hooks/#trusting-a-projects-hooks).
- **Project allow rules aren't gated.** A cloned repo's `.claude/settings.json` or `.rein/settings.json` can ship `permissions.allow` rules, which apply without a trust prompt. Read them before you start.
- **Memory writes don't ask.** `remember` and `forget` edit `.rein/MEMORY.md` in the project without approval.
- **Windows has no `O_NOFOLLOW`.** Rein checks for a symlink explicitly instead, which leaves a tiny race window.
- **The Jev key briefly appears in a process argument list** while it's saved to the macOS Keychain (`security add-generic-password`).
- **Jev sees excerpts.** With Jev as the decision model, the minimal state for each decision (message head and tail, the action and a change preview, goal evidence excerpts) is sent to typesafe.ai. Use `cheapest` to keep decisions on your own accounts. See [Decision model](../../internals/decision-model/).
- **Transcripts are plaintext.** `~/.rein/sessions/` holds your messages and tool-result excerpts, written `0600` in a `0700` folder.
- **MCP servers are your code.** A stdio server runs with your environment, and an HTTP one sees what you send it. Adding one always asks, but a malicious server is out of scope.

## Your accounts, your responsibility

Rein drives your own subscriptions through the providers' official CLIs. It doesn't proxy, share or pool access between people. Whether running several accounts of the same provider fits that provider's terms is your call. Check the terms of each subscription you use.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately on GitHub: **Security → Report a vulnerability** on the repository ([direct link](https://github.com/DarKnight1346/rein-harness/security/advisories/new)).

Include what you found, how to reproduce it, and your Rein version (`rein --version`). You'll get a reply within a few days. Fixes ship as a new npm release, and the advisory is published once users can update.

Only the latest npm release is supported. Rein updates itself on launch, and `rein --update` installs the newest version.

Reports that matter most: anything that lets a model, a web page or a pasted file **escape the project folder**, **run commands without the configured approval**, **reach local or private network hosts through `web_fetch`**, or **expose account credentials or the Jev API key**.

## Related

- [Permissions](../../features/permissions/)
- [Drivers](../../internals/drivers/)
- [Files & directories](../../reference/files/)
- [FAQ & troubleshooting](../faq/)
