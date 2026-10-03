# Rein

A terminal chat harness that looks like Claude Code and drives the official `claude` and `codex`
CLIs across one or more subscription accounts, with per-task model routing (Jev or a cheap model)
and a compaction model. No OAuth tokens are extracted: all traffic goes through the CLIs.

```sh
npm install && npm run build && npm link   # then: rein   (or: npm run dev)
rein --continue [id]                        # pick a saved conversation from this project to continue
rein --classic                              # inline renderer (native scrollback, no mouse)
```

Fullscreen (default): top status bar (click model / usage / context), scrollable history (wheel,
PgUp/PgDn), sidebar (accounts, models, session; ctrl+b), clickable menus, drag to select + copy.
In Terminal.app make sure View → Allow Mouse Reporting is on.

| Command | |
|---|---|
| `/login` | Accounts: list, add Claude/Codex accounts, re-authenticate, remove; Jev API key |
| `/model` | Chat model (`auto` or a model), decision model, compaction model · `/model auto`, `/model sonnet` |
| `/usage` | Usage windows (5h / weekly / 30-day) and reset times per account · `/usage refresh` |
| `/agents` | Subagents; click to view and message one (`/agent <id|main>` switches) |
| `/resume` | Continue a saved conversation from this project |
| `/goal` | `/goal <text>` keeps the agent on it until the decision model verifies it's done (evidence required); `pause` · `resume` · `clear` |
| `/btw` | Side question answered by a fork of the agent, without interrupting it |
| `/shells` | Agent shell commands and their logs |
| `/compact` | Summarize the conversation with the compaction model |
| `/update` | `claude update`, `codex update`, Codex protocol check, Rein self-update |
| `/context` | Context window usage grid |
| `/configure` | Choose/reorder status-line segments and sidebar sections (alias `/config`) |
| `/tui` | `/tui fullscreen` or `/tui classic` |
| `/clear`, `/help`, `/exit` | |

State lives in `~/.rein/` (`REIN_HOME` overrides): `accounts.json`, `config.json`,
`accounts/<provider>/<id>/` (per-account CLI homes), `state/usage.json`, `sessions/`.
A custom system prompt can go in `~/.rein/system-prompt.md`.

Agent tools: list · read · write · edit · delete · search · shell (foreground/background, `/shells`),
limited to the current project. File changes and commands need approval: `/configure` → Approvals
(ask / auto via the decision model / bypass). `/btw <question>` forks the agent to answer on the side.
Ctrl+C stops the agent; press it twice to exit.
Subagents: the agent can delegate with its `agent` tool (fork the conversation, or a new session on any
signed-in model / auto); they appear in the sidebar — click one to view and message it. A decision-model
check makes them continue until done. `/model` → Advisor lets agents consult a stronger model.
Skills: folders with a `SKILL.md` (plus any scripts/files) in `<project>/.rein/skills` or `~/.rein/skills`;
optional `config.json` (`name`, `description`, `main`, `aliases`). Name clashes: built-in → project →
global. Run as `/name args`; `/skill:create` and `/skill:edit` (built in) have the agent write them for you.
AGENTS.md: `~/.rein/AGENTS.md` plus the project's AGENTS.md files are added to the system prompt.

Design, findings and status: [PLAN.md](PLAN.md). Tests: `npm test`.

### Input
- Big pastes collapse to `[Pasted text #1 +42 lines]`; Ctrl+V pastes a clipboard image; drag a file
  onto the terminal to attach it (images go to the model as images). Backspace removes a token.
- Fullscreen: drag over the history to select — releasing copies it.

### Web
- `web_search` and `web_fetch` work with any chat model: searches run on the /model → Web model with
  its provider's built-in search; fetched pages become markdown (optionally summarized for a prompt).

### Privacy
- On by default: emails show as "Claude Account 1" / "Codex Account 1" and your home folder as `~`, so
  screenshots are shareable. Toggle in /configure → Privacy.
