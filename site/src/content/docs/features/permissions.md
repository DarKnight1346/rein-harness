---
title: Permissions
description: How Rein decides whether a tool call runs, asks you, or is refused — approval modes, working directories, sensitive paths, saved rules and the exact order they're checked in.
---

Every tool call any model makes goes through one checkpoint in Rein, whichever provider is driving: the same rules, the same prompt, the same transcript note telling you *why* it ran. You choose how much to hand over, from "ask me about everything" to "go", and Claude Code's `permissions` rules carry straight over.

```text title="rein"
╭──────────────────────────────────────────────────────────────────────╮
│ Rein wants to Shell $ npm test -- --watch=false                      │
│                                                                      │
│ $ npm test -- --watch=false                                          │
│                                                                      │
│ [1 Allow]  [2 Allow all changes & commands this session]             │
│ [3 Always allow shell(npm test:*) (this project)]  [4 Deny]          │
│ enter/1 allow · 2 allow session · 3 always · esc/4 deny              │
╰──────────────────────────────────────────────────────────────────────╯
```

Press `3` once and the next test run shows up as `⏺ Shell($ npm test) · allowed by rule`, with no prompt.

## What asks and what doesn't

Tools fall into two groups:

- **Mutating** tools change something, so they go through approval: `write`, `edit`, `delete`, `shell`, `image_generate`, `mcp_add`, `mcp_remove`, and every MCP server tool that doesn't declare `readOnlyHint` (see [MCP](../mcp/)).
- **Non-mutating** tools run without asking as long as they stay inside your [working directories](#working-directories): `read`, `list`, `search`, `web_search`, `web_fetch`, `remember`, `forget`, session search, `todo_write`, `ask_user` and the rest.

That means reading `.env` *inside* your project never prompts. Rein treats the project folder as yours to read. If that's not what you want, add a [deny rule](#saved-rules).

## The command sandbox

Approvals decide *whether* a command runs. The sandbox limits *what it can do* once it runs, which is what makes long unattended runs (bypass mode, `/goal`) safe. It's **on by default** (`/settings` → **General → Sandbox**):

| Mode | The agent's shell commands… |
|---|---|
| **On** (`write`, default) | can only write inside the project, its working directories (including `/add-dir` folders), the session scratchpad, temp folders and package-manager caches (`~/.npm`, `~/.cache`, `~/.cargo`…). Reading and the network work as usual. |
| **Strict** | the same, and no network except `localhost` (local dev servers and databases keep working). |
| **Off** | run with no sandbox: approvals are the only guard. |

Even inside the project, files that could run code *outside* the sandbox later stay read-only: `.git/hooks`, `.git/config`, `.gitmodules`, `.mcp.json`, `.claude/` and `.rein/` settings, `.vscode/`, `.idea/`. So `git init` and `git config` need to run unsandboxed.

When a command fails because of the sandbox (`Operation not permitted`, or a network error in strict mode), the agent is told why and can retry with `unsandboxed: true`. **That always asks you**, even in bypass mode, and no saved rule or "allow for the session" covers it.

`lsp_install`, which installs a [language server](../code-intelligence/#installing-a-server) into Rein's folder, also always asks, even in bypass mode.

macOS uses `sandbox-exec` (Seatbelt), as Claude Code and Codex do. Linux uses bubblewrap (install the `bubblewrap` package); without it, and on Windows, commands run unsandboxed and Rein says so at startup. Only the agent's commands are sandboxed: your own [`!` commands](../../reference/commands/#shell-commands-with-), hooks and MCP servers aren't.


On macOS it also allows Bazel's output folder (`/private/var/tmp/_bazel_<you>`) when it exists, so sandboxed Bazel builds work. See [Build caches](../build-and-test/#build-caches).

## Approval modes

Pick a mode in `/settings` → **General → Approvals** (saved as `toolApproval` in `~/.rein/config.json`). The mode only decides what happens to mutating calls that nothing else (a rule, a hook, the scratchpad, the read-only list) has already settled.

| Mode | What happens |
|---|---|
| `ask` (default) | You approve every mutating call. |
| `auto` | The [decision model](../../internals/decision-model/) is asked one question: is this clearly something you asked for, and safe? At **0.85 or higher** it runs, and the transcript shows the score, e.g. `⏺ Edit(src/app.ts) · auto-approved (0.91 via jev)`. Anything lower, or a judge failure, **comes to you**. Auto mode never denies on its own. |
| `bypass` | Every mutating call runs without asking, except the cases listed under [what bypass still stops](#what-bypass-still-stops). |

The `auto` judge sees only your latest message, the action (`Shell $ npm run build`) and a clipped preview of the change. For shell commands it's told to refuse deletions, force-pushes, installing system software, touching credentials and contacting unexpected hosts. For file changes it's told to refuse deleting or overwriting unrelated work.

:::note
The `/settings` screen describes approvals in terms of file changes. The mode applies to **every** mutating tool, including `shell` and MCP tools.
:::

### What bypass still stops

- **Deny rules.** They're checked before anything else, in every mode.
- **Sensitive paths outside the working directories** used by a file tool. They get a one-time prompt (see [sensitive locations](#sensitive-locations)).
- **Plan mode.** A command that isn't known to be read-only is refused outright in bypass mode, not prompted (see [plan mode](#plan-mode)).
- **PreToolUse hooks** that block or ask.

## The approval prompt

| Key | Choice | Effect |
|---|---|---|
| `1`, `y`, Enter | **Allow** | This call only. |
| `2`, `a` | **Allow … this session** | Depends on context, see below. |
| `3` | **Always allow `<rule>` (this project)** | Saves the suggested rule to `<project>/.rein/settings.json` and allows this call. |
| `4`, `n`, Esc | **Deny** | The model is told you said no and to ask how to proceed rather than retry. |

Option 2's label tells you exactly what you're granting:

- **Inside the project:** `2 Allow all changes & commands this session`. This is broad: for the rest of the session, *every* mutating call runs without asking (except `mcp_add`, which always asks in ask/auto mode).
- **Outside, writing:** `2 Allow this folder this session` (or `these folders`). The folder becomes a working directory until you quit.
- **Outside, reading:** `2 Allow reads outside the project this session`. Non-sensitive reads anywhere stop asking.

Option 3 only appears when Rein can suggest a sensible rule. It suggests:

- `shell(<program>:*)` for a single command, or `shell(<program> <subcommand>:*)` for tools with subcommands (`npm test`, `git status`, `cargo build`, `docker compose` and about thirty others). Compound commands get no suggestion, so you approve each kind separately.
- `edit(<folder>/**)` for a file change, using the file's folder (`edit(**)` at the project root). Outside the project the folder is written `~/…` or absolute.
- `web_fetch(domain:<host>)` for a fetch.

**Sensitive** prompts and **plan-mode** prompts drop options 2 and 3: you get *Allow once* or *Deny*.

Subagents share the same prompt. Their requests are labelled `Subagent <name> wants to …`. When several agents ask at once, requests queue and show one at a time (`Approve command (1 of 3) · subagent reviewer`). Choosing option 2 also approves **every request already waiting in the queue**, whatever it is, so check the count before pressing it.


When the [exfiltration guard](../safety/#data-leaving-the-machine-exfilguard) asks about a network call, the prompt says why in red and offers only *allow once* or *deny*.

## Working directories

The tools work freely in:

- the project folder (where you launched `rein`),
- this session's scratchpad (`~/.rein/scratch/<session-id>/`),
- your global skills folder (`~/.rein/skills`), so `/skill:create` can write there,
- anything in `additionalDirectories` in `~/.rein/config.json`,
- folders added with `/add-dir <path>` or `rein --add-dir <path>` (session only),
- the cloned repos of a [workspace](../workspaces/) (`rein.workspace.yaml`),
- folders you allowed with option 2 of an outside-path prompt (session only).

`/add-dir` with no argument lists them all. Symlinks are resolved before the check, so a link inside the project pointing at `/etc` counts as `/etc`.

**File changes in the scratchpad never ask**, in any mode. They also don't create [rewind](../rewind/) checkpoints.

### Outside paths

When a file tool (`read`, `list`, `search`, `write`, `edit`, `delete`, `image_generate`, or the `cwd` of `shell`) names a path outside every working directory, Rein asks about *access* first:

```text title="rein"
Rein wants to Read ~/notes/deploy.md
Outside the project: ~/notes/deploy.md
```

How that resolves, in order:

1. An **allow rule** covering the path → runs.
2. **Bypass** mode, and the path isn't sensitive → runs.
3. A read, after you chose "Allow reads outside the project this session" → runs.
4. **Auto** mode, a read (not a write), not sensitive → the decision model decides. Below 0.85 it asks you.
5. Otherwise → the prompt.

Writes outside the project always come to you in `ask` and `auto` modes. The judge never approves them.

:::caution[Shell commands aren't confined]
Confinement covers the **file tools' path arguments** and the shell's working directory. It does not look inside shell commands. `cat ~/Documents/x.txt` is an ordinary shell call. In `ask` mode you see it in the prompt; in `bypass` mode it runs. A command that names an outside path does lose its "read-only, runs without asking" status, though (see the [pipeline](#the-full-pipeline)).
:::

## Approving from another device

With the [remote page](../remote/) on, every approval also shows on paired devices. Answer it in Rein or on the page; the first answer wins. The options are the same, and sensitive locations only get a one-time yes there too.
## Work from issue trackers always asks

Work started by an [issue tracker](../trackers/) runs on text someone else wrote, so every action it takes asks you, even in bypass or auto mode.

## Sensitive locations

Some paths only ever get a one-time yes, even in bypass mode, and the prompt turns red:

```text title="rein"
⚠ Sensitive location (credentials/secrets) outside the project: ~/.aws/credentials
enter/1 allow once · esc/4 deny
```

The list, under your home folder: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gcloud`, `.config/gh`, `.netrc`, `.npmrc`, `.git-credentials`, `.pypirc`, `Library/Keychains`, `.claude`, `.claude.json`, `.codex`, `.rein/accounts`, `.rein/accounts.json`, and Rein's `secrets/` folder (the vault and the Jev key, wherever the data folder is). Anywhere on disk: any file named `.env` or `.env.<something>`, and any `*.pem`, `*.key`, `*.p12`, `*.pfx` or `*.keychain`.

:::danger[Know exactly what this covers]
The sensitive check runs **only for file-tool paths outside the working directories**. Precisely:

- A `.env` or `*.pem` **inside** your project or another working directory is an ordinary file: readable without a prompt, editable under your normal mode.
- **Shell commands are not inspected.** In bypass mode, `cat ~/.ssh/id_ed25519` runs.
- An **allow rule** that covers a sensitive path (say `read(~/.ssh/**)`) approves it without a prompt. So does a **PreToolUse hook** that returns allow.

If you run bypass mode, treat the sensitive list as a seatbelt for the file tools, not a sandbox.
:::

## Secret scanning

With `secretScan` on, every `write` and `edit` is checked for credentials it would **add** to a file: private keys, AWS, GitHub, GitLab, Slack, Stripe, Anthropic, OpenAI, Google and npm keys, JSON web tokens, and long random values assigned to names like `password`, `apiKey` or `client_secret`. Placeholders (`your-password-here`, `xxxx`, `${process.env.TOKEN}`) and plain words aren't flagged, and moving a line that was already there isn't a new one.

| `secretScan` | What happens |
|---|---|
| `off` *(default)* | Nothing. |
| `warn` | The change goes through, and the agent is told it added what looks like a credential and to move it to an environment variable (or say it's a fake for tests). |
| `block` | The change is refused with the reason, and the agent is told to read the value from the environment or ask you to add it. |

While it's on, credentials are also masked in saved conversations (`~/.rein/sessions/`), keeping the first four characters (`AKIA…[secret: AWS access key]`). Set it with `/settings secretScan warn`. For secrets the agent needs to *use*, see the [vault](../vault/): it runs commands with them without ever seeing them.

For rules that hold in every mode, bypass included, with reasons the agent sees (and limits on which models may work in a repo), see [Policy as code](../safety/#policy-as-code-reinpolicyyaml).

## Saved rules

Rules use Claude Code's format: a tool name, optionally with a specifier in parentheses, in `allow` or `deny` lists under `permissions`.

```json title=".rein/settings.json"
{
  "permissions": {
    "allow": [
      "shell(npm test:*)",
      "shell(npm run lint)",
      "shell(git status:*)",
      "edit(src/**)",
      "edit(docs/*.md)",
      "read(~/notes/**)",
      "mcp__github__search_issues"
    ],
    "deny": [
      "shell(git push:*)",
      "shell(rm:*)",
      "read(**/.env*)",
      "edit(package-lock.json)",
      "web_fetch(domain:pastebin.com)",
      "mcp__prod-db"
    ]
  }
}
```

**Deny always wins.** A call any deny rule covers is refused, in every mode, for every tool, before hooks or prompts. The model is told `blocked by a permission rule (deny) in the user's settings; ask the user instead of retrying`.

### Rule syntax

| Rule | Covers |
|---|---|
| `shell` | Every shell command. As a deny rule, this blocks the shell entirely. |
| `shell(npm test)` | Exactly `npm test` (whitespace normalized). |
| `shell(npm test:*)` | `npm test` and `npm test` followed by anything (`npm test -- --watch`). It's a prefix on words, so `npm tests` doesn't match. |
| `edit` | Every file change. |
| `edit(src/**)` | `edit`, `write`, `delete` and `image_generate` under `src/`, at any depth. An `edit` with several `edits` is checked against every file in it. |
| `edit(*.md)` | Markdown files at the project root only (`*` doesn't cross `/`). |
| `edit(/abs/path/**)`, `edit(~/x/**)` | Absolute or home-relative paths. |
| `read(~/notes/**)` | The `read` tool on those paths. `list(…)` and `search(…)` work the same way. |
| `web_fetch(domain:example.com)` | `example.com` and its subdomains. |
| `mcp__github` | Every tool of the MCP server `github`. |
| `mcp__github__create_issue` | One MCP tool. |
| `mcp_add` | The agent's `mcp_add` tool (any Rein tool name works bare). |

Path globs: `**` matches any depth, `*` matches within one path segment, `?` matches one character. Paths are matched both project-relative (`src/app.ts`) and absolute, so either form works in a rule. A call that touches several paths is allowed only if every path is covered, and denied if any one is.

**Claude Code names work too**, case-insensitively: `Bash` → `shell`, `Edit` / `Write` / `MultiEdit` / `Delete` → `edit`, `Read` → `read`, `WebFetch` → `web_fetch`, `WebSearch` → `web_search`. So `Bash(npm test:*)` from an existing `.claude/settings.json` works unchanged. Other Claude names (`Grep`, `Glob`, `LS`, `Task`) aren't mapped; use Rein's names (`search`, `list`, `agent`).

:::note[Rules that do nothing]
Allow rules for `web_fetch`, `web_search`, or `read` inside the project have no effect, because those calls never ask in the first place. Their **deny** rules do work. Likewise `read(…)` only governs the `read` tool: a `read(**/.env*)` deny rule doesn't stop `search` or `shell cat .env`. Add `search(**/.env*)` too, and don't rely on rules alone to stop the shell.
:::

### Compound shell commands

Rein splits a command on `&&`, `||`, `;`, `|` and newlines (outside quotes) and checks each part:

- **Allow** only if *every* part is allowed. With `shell(npm test:*)` allowed, `npm test && rm -rf build` still asks.
- **Deny** if *any* part is denied. With `shell(git push:*)` denied, `git commit -m x && git push` is refused.
- Commands containing `$( … )`, backticks, `<( … )` or `>( … )` can't be vetted, so allow rules never match them, and **neither do deny rules with a pattern** (a bare `shell` deny still blocks them, because it blocks every command). They fall through to your approval mode: a prompt in `ask` mode, the judge in `auto` mode. In `bypass` mode they run.

:::caution[Rules are a guardrail, not a sandbox]
Matching is on the literal start of each simple command. `shell(rm:*)` doesn't match `sudo rm …`, `/bin/rm …`, `env rm …` or `rm $(…)`. If something must never happen, keep `bypass` off, and consider a bare `"deny": ["shell"]` or a [PreToolUse hook](../hooks/) that inspects the command properly.
:::

### Where rules come from

Rein reads six settings files on **every tool call**, so edits apply immediately. All of their `allow` and `deny` lists are combined; no file overrides another, and a deny anywhere beats an allow anywhere.

| # | File | Typical use |
|---|---|---|
| 1 | `~/.claude/settings.json` | Your existing Claude Code rules |
| 2 | `~/.rein/settings.json` | Your rules for every project |
| 3 | `<project>/.claude/settings.json` | The repo's shared Claude Code rules |
| 4 | `<project>/.claude/settings.local.json` | Your personal Claude Code rules for this repo |
| 5 | `<project>/.rein/settings.json` | Where "3 Always allow" saves rules |
| 6 | `<project>/.rein/settings.local.json` | Your personal Rein rules for this repo |

The same files carry [hooks](../hooks/).

:::caution
"Always allow" writes to `.rein/settings.json`, not the `.local` file. If you commit `.rein/`, your teammates inherit those allow rules. Move personal rules to `.rein/settings.local.json` and keep that file out of git. The reverse also holds: a repo you clone can ship allow rules in its `.claude/settings.json` or `.rein/settings.json`. Read them before you start working.
:::

### `/permissions`

Lists every rule in effect, grouped by the file it came from:

```text title="rein"
Permission rules (deny wins):
~/.claude/settings.json
  allow Bash(npm run build:*)
~/code/app/.rein/settings.json
  allow shell(npm test:*)
  allow edit(src/**)
  deny  shell(git push:*)
```

## Plan mode

While plan mode is on (`/plan`, `/plan:deep`, Shift+Tab, or `rein -p --permission-mode plan`):

- File changes are refused, except in the scratchpad.
- Shell commands on Rein's read-only list run (see below).
- Any other command goes to the decision model: "does this only read?" At 0.85 or higher it runs. Otherwise **bypass mode refuses it** and the other modes prompt with only *Allow* / *Deny*:

```text title="rein"
⏸ Plan mode: this command isn't known to be read-only — allow it only if it just looks things up.
```

See [Plans](../plans/) for the rest.

## Read-only commands

Commands Rein knows only read run without a prompt in every mode, the way Claude Code handles them: `ls`, `cat`, `head`, `grep`, `rg`, `find` (without `-delete` / `-exec`), `wc`, `diff`, `jq`, `ps`, `which` and dozens more, plus the reading subcommands of `git` (`status`, `log`, `diff`, `show`, `blame`, `branch --list`, …), `npm` (`ls`, `view`, `outdated`, …), `docker` (`ps`, `images`, `logs`, …), `kubectl get/describe/logs`, `brew info`, and any `<program> --version` or `--help`. Every part of a compound command must qualify, and `>` / `>>` redirections into files disqualify it.

A read-only command loses that status, and goes through normal approval for your mode, if it names an absolute or `~` path outside the working directories or uses `..`. A PreToolUse hook that asks also forces a prompt.

## The full pipeline

This is the order `ToolHost.call` runs for every tool call, from any model or subagent:

1. **Main-agent-only tools** (`agent`, `ask_user`, `todo_write`, `present_plan`, …) are refused for subagents.
2. **Permission rules.** A deny blocks the call outright. An allow is remembered for later steps.
3. **PreToolUse hooks** run. Exit code 2 or a deny decision blocks; they can also allow or force a prompt.
4. **Read-only check.** Is this a shell command on the read-only list that names no outside paths?
5. **Plan mode.** File changes are refused; unlisted commands go to the read-only judge, then refuse (bypass) or prompt (other modes).
6. **Hook allow.** If a hook returned allow (and didn't also ask), the call is approved here.
7. **Outside paths.** Rule → bypass (not sensitive) → session outside reads → auto judge (reads only) → prompt.
8. **Scratchpad.** File changes inside the scratchpad are approved.
9. **Read-only shell** commands are approved, unless a hook asked for a prompt.
10. **Mutating approval.** Hook-ask or plan mode → prompt. Otherwise: allow rule → bypass → session allow (not for `mcp_add`) → auto judge (not for `mcp_add`) → prompt.
11. **Checkpoint.** Files an `edit`-group tool is about to change are snapshotted for [/rewind](../rewind/).
12. **Run**, then **PostToolUse hooks**. The result is capped at 60,000 characters.

Every tool line in the transcript records which step approved it: `· allowed by rule`, `· allowed by hook`, `· bypass`, `· allowed for session`, `· scratchpad`, `· auto-approved (0.91 via jev)` or `· you approved`.

## Headless runs

With `rein -p` nobody is around to answer, so every prompt becomes a denial. Omitting `--permission-mode` uses your configured `toolApproval`, **including `bypass`**. See [Headless mode](../headless/#permissions).

## Under the hood

Rein can enforce all of this because the models never get their own tools. Claude Code runs with its built-in tools switched off (`--tools ""`) and its settings sources disabled; Rein's tools reach it through an MCP proxy. Codex threads run with `sandbox: read-only` and `approvalPolicy: untrusted`, and Rein's tools are passed in as dynamic tools. Every file change and command therefore goes through the pipeline above.

## Related

- [Tools](../tools/): what each tool does
- [Hooks](../hooks/): programmable approvals
- [MCP](../mcp/): server tools and `readOnlyHint`
- [Plans](../plans/): plan mode in depth
- [Headless mode](../headless/): permissions without a human
- [Configuration reference](../../reference/configuration/)
- [Security](../../project/security/)
