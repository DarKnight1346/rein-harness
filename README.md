# Rein

[![npm](https://img.shields.io/npm/v/rein-harness)](https://www.npmjs.com/package/rein-harness)
[![CI](https://github.com/DarKnight1346/rein-harness/actions/workflows/publish.yml/badge.svg)](https://github.com/DarKnight1346/rein-harness/actions/workflows/publish.yml)
[![CodeQL](https://github.com/DarKnight1346/rein-harness/actions/workflows/codeql.yml/badge.svg)](https://github.com/DarKnight1346/rein-harness/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/DarKnight1346/rein-harness/badge)](https://scorecard.dev/viewer/?uri=github.com/DarKnight1346/rein-harness)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue)](https://www.npmjs.com/package/rein-harness#provenance)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A terminal chat harness that looks like Claude Code and drives the official `claude` and `codex`
CLIs across one or more subscription accounts, with per-task model routing (Jev or a cheap model)
and a compaction model. No OAuth tokens are extracted: all traffic goes through the CLIs.

**📖 Full documentation: [rein-harness.github.io](https://rein-harness.github.io/)** · [Contributing](CONTRIBUTING.md)

**Built for big systems.** Open-source features for very large, multi-repo codebases, shipping in waves
([what's new](https://rein-harness.github.io/start/whats-new/), [roadmap](ROADMAP.md)):

- **Multi-repo workspaces:** a `rein.workspace.yaml` makes every repo a working directory, with one
  AGENTS.md for all; `--scope` focuses on one package of a monorepo.
- **Cost and budgets:** dollars per request, conversation and goal (`/cost`), caps that stop runaway
  work, goal estimates, OpenTelemetry export.
- **Safety guards:** secret scanning, Semgrep on changes, planted-instruction and exfiltration guards,
  pinned MCP servers, a dependency check and policy as code (`.rein/policy.yaml`).
- **Build, test and CI:** affected targets from Nx/Turborepo/Bazel/Pants (`/affected`), a CI watcher
  that fixes failing checks (`/ci watch`), coverage and mutation testing of your changes, flaky-test
  quarantine, a [GitHub Action](action.yml) and a GitLab CI component.
- **Coming next:** PR review flow, specs, contracts and migrations, and system-level understanding
  across repos.

## Install

**Requirements**
- macOS, Linux or **Windows**, and **Node.js 22+** (`node --version`)
- Windows: [Git for Windows](https://git-scm.com/download/win) is recommended — the agent's shell and hooks then use Git Bash (as in Claude Code); without it they fall back to PowerShell. Use Windows Terminal.
- At least one of the official CLIs, installed and signed in:
  - **Claude Code** — `curl -fsSL https://claude.ai/install.sh | bash` (or `npm install -g @anthropic-ai/claude-code`), then run `claude` once to sign in
  - **Codex** — `npm install -g @openai/codex`, then `codex login`

**Install Rein**

```sh
npm install -g rein-harness
```

**Run it** from the project folder you want to work in — Rein's tools are limited to that folder:

```sh
cd ~/code/my-project
rein
```

Or try it without installing: `npx rein-harness`.

If npm fails with `EACCES` (a root-owned global folder), either use `sudo npm install -g rein-harness`
or point npm at a folder you own once, then install again:

```sh
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
```

**First run**
- Rein finds your existing `claude` / `codex` logins and offers to import them (used in place; it never
  logs them out). Add more accounts — e.g. a second Claude subscription — with `/login`.
- Optional: add a [Jev](https://typesafe.ai) API key in `/login` to use Jev as the decision model;
  otherwise the cheapest signed-in model makes routing decisions.
- Pick models with `/model`; `/help` lists every command.
- In Terminal.app, turn on View → Allow Mouse Reporting for clicks and scrolling.

**Updating:** Rein checks npm on launch and installs new versions in the background (restart to use
them). `rein --update` (or `/update`) updates Rein plus the `claude` and `codex` CLIs.

**Uninstall:** `npm uninstall -g rein-harness`. Rein's data lives in `~/.rein/` — delete it to remove
saved conversations, settings and Rein-added accounts (your own CLI logins are untouched).

**From source**

```sh
git clone https://github.com/DarKnight1346/rein-harness.git && cd rein-harness
npm install && npm run build && npm link   # then: rein   (or: npm run dev)
```

## Usage

```sh
rein                     # start in the current folder (fullscreen UI)
rein --continue [id]     # pick a saved conversation from this project to continue
rein --classic           # inline renderer (native scrollback, no mouse)
rein --add-dir ../shared # let the agent also use another folder without asking
rein --update            # update Rein and the CLIs, then exit
rein --version
```

Fullscreen (default): top status bar (click model / usage / context), scrollable history (wheel,
PgUp/PgDn), sidebar (accounts, models, session; ctrl+b), clickable menus, drag to select + copy.
In Terminal.app make sure View → Allow Mouse Reporting is on.

| Command | |
|---|---|
| `/login` | Accounts: list, add Claude/Codex accounts, re-authenticate, remove; Jev API key |
| `/model` | Chat model (`auto` or a model), subagent model, decision, compaction, advisor and web models · `/model auto`, `/model sonnet` |
| `/usage` | Usage windows (5h / weekly / 30-day) and reset times per account · `/usage refresh` |
| `/agents` | Subagents; click to view and message one (`/agent <id|main>` switches) |
| `/resume` | Continue a saved conversation from this project |
| `/goal` | `/goal <text>` keeps the agent on it until the decision model verifies it's done (evidence required); `pause` · `resume` · `clear` |
| `/btw` | Side question answered by a fork of the agent, without interrupting it |
| `/shells` | Agent shell commands and their logs |
| `/compact` | Summarize the conversation with the compaction model |
| `/update` | Update Rein (npm), `claude` and `codex`, then check the Codex protocol |
| `/context` | Context window usage grid |
| `/add-dir` | Add a working directory for this session (no path: list them) |
| `/settings` | Settings: status line, sidebar, approvals, sandbox, shell, subagents, goals and more |
| `/tui` | `/tui fullscreen` or `/tui classic` |
| `/clear`, `/help`, `/exit` | |

State lives in `~/.rein/` (`REIN_HOME` overrides): `accounts.json`, `config.json`,
`accounts/<provider>/<id>/` (per-account CLI homes), `state/usage.json`, `sessions/`.
A custom system prompt can go in `~/.rein/system-prompt.md`.

Agent tools: list · read · write · edit · delete · search · shell (foreground/background, `/shells`).
They work freely inside the project and its working directories (`/add-dir <path>`, `rein --add-dir <path>`,
or `additionalDirectories` in `~/.rein/config.json`); paths anywhere else ask first — reads can be allowed
for the session, writes always need a yes, and credentials/secrets always ask, even in bypass mode. File changes and commands need approval: `/settings` → Approvals
(ask / auto via the decision model / bypass). `/btw <question>` forks the agent to answer on the side.
Ctrl+C stops the agent; press it twice to exit.
Subagents: the agent can delegate with its `agent` tool (fork the conversation, or a new session on any
signed-in model / auto); they appear in the sidebar — click one to view and message it. A decision-model
check makes them continue until done. `/model` → Advisor lets agents consult a stronger model.
Skills: folders with a `SKILL.md` (plus any scripts/files) in `<project>/.rein/skills` or `~/.rein/skills`;
optional `config.json` (`name`, `description`, `main`, `aliases`). Name clashes: built-in → project →
global. Run as `/name args`; `/skill:create` and `/skill:edit` (built in) have the agent write them for you.
AGENTS.md: `~/.rein/AGENTS.md` plus the project's AGENTS.md files are added to the system prompt.

Design, findings and status: [PLAN.md](PLAN.md). Tests: `npm test`. License: [MIT](LICENSE). Security: [SECURITY.md](SECURITY.md).

### Input
- Big pastes collapse to `[Pasted text #1 +42 lines]`; Ctrl+V pastes a clipboard image; drag a file
  onto the terminal to attach it (images go to the model as images). Backspace removes a token.
- Fullscreen: drag over the history to select — releasing copies it.

### Images
- `image_generate` gives every chat model (Claude included) Codex's image generation: describe an image, or pass
  reference images to edit. PNGs save to the scratchpad or a path you give. Shown only while a Codex account
  that can generate images is signed in.

### Web
- `web_search` and `web_fetch` work with any chat model: searches run on the /model → Web model with
  its provider's built-in search; fetched pages become markdown (optionally summarized for a prompt).

### Privacy
- On by default: emails show as "Claude Account 1" / "Codex Account 1" and your home folder as `~`, so
  screenshots are shareable. Toggle in /settings → Privacy.

### Updates
- Auto-update on launch can be turned off in /settings → Updates.

### Getting the most out of a project
- **Permissions:** "Always allow" in an approval prompt saves a rule (`shell(npm test:*)`, `edit(src/**)`) to
  `.rein/settings.json`; `/permissions` lists them. Existing `.claude/settings.json` rules apply too.
- **Undo:** `/rewind` (or esc twice) restores files and/or the conversation to before one of your messages.
- **Plan first:** `/plan <task>` (or `/plan:deep` for big, risky changes) — the agent explores read-only, asks you
  questions, then presents a plan with milestones. Save it and implement now, save it and start it as a goal
  (milestones verified one by one, progress in the sidebar), or save it for later (`/goal:plan` starts a saved plan).
  Plans live in `.rein/plans/`. Shift+Tab toggles plan mode.
- **Questions:** the agent can ask you multiple-choice questions (with your own answer as an option) mid-task.
- **Tasks and effort:** the agent keeps a task list in the sidebar for multi-step work; pick an effort level (or
  auto) after choosing a model in `/model`.
- **Context:** `@path` attaches a file; `read` shows images and PDFs to the model.
- **MCP:** just ask — the agent can add, list and remove servers itself (adding always asks you first, showing
  the command). They live in `.mcp.json` / `~/.rein/mcp.json`; servers from `claude mcp add` work too. `/mcp` to review.
- **Hooks:** Claude Code's `hooks` block in `.rein/settings.json` or `.claude/settings.json`.
- **Scripts/CI:** `rein -p "…"` (`--output-format json`, `--permission-mode`, `--allowedTools`).
