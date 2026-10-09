# AGENTS.md — working on Rein

Instructions for AI agents (Rein, Claude Code, Codex, …) and humans changing this repository.
`CLAUDE.md` imports this file, so there is one source of truth: edit this one.

## What this is

Rein (`rein-harness` on npm, binary `rein`) is a terminal coding assistant that drives the official
`claude` and `codex` CLIs across multiple subscription accounts. It gives every model one shared tool
set and adds routing, failover, goals, plans, `/btw`, rewind and subagents. TypeScript + Ink (React)
on Node 22+.

**Hard rule:** never extract, read or reuse OAuth tokens. All model traffic goes through the official
`claude` / `codex` binaries (see `PLAN.md` §1). Never pass `--bare` to `claude`.

## Commands

```sh
npm install
npm run dev          # run from source (tsx src/cli.ts)
npm run typecheck    # tsc --noEmit
npm test             # vitest; uses fake CLIs in test/fixtures, no subscription needed
npm run build        # tsc → dist/

# docs site (site/)
cd site && npm ci
npm run dev          # http://localhost:4321
npm run build
node scripts/check-docs.mjs   # docs drift check, also runs in CI
```

## Map

| Path | What lives there |
|---|---|
| `src/cli.ts`, `src/app.tsx`, `src/headless.ts` | Entry point (production React), flags and renderer loop, `rein -p` |
| `src/runtime.ts` | Wires everything together for a session |
| `src/session/` | Engine (turn loop, failover, carry), transcript, compaction, `/btw`, checkpoints, snapshots, system prompt |
| `src/providers/{claude,codex}/` | CLI drivers: Claude stream-json, Codex app-server JSON-RPC |
| `src/router/`, `src/decider/` | Model catalog, auto routing, decision model (Jev or a cheap LLM) |
| `src/accounts/`, `src/store/` | Account registry, usage refresh, config, secrets, `~/.rein` paths |
| `src/tools/` | Tool host (approvals and permissions) and the tools every model gets |
| `src/agents/`, `src/goals/`, `src/plans/` | Subagents and advisor, `/goal`, saved plans |
| `src/mcp/`, `src/hooks.ts`, `src/skills/` | MCP client, Claude Code-compatible hooks, skills |
| `src/ide/` | Editor integration over the Claude Code IDE extension protocol (selection, diffs, diagnostics) |
| `src/ui/` | Ink UI: fullscreen and classic renderers, windows, input |
| `skills/` | Built-in skills shipped with the package (`/plan`, `/plan:deep`, `/skill:create`, `/skill:edit`) |
| `test/` | vitest suites, `test/fixtures/fake-{claude,codex}.mjs` |
| `site/` | Documentation site (Astro + Starlight), deployed to GitHub Pages |
| `PLAN.md` | Design history and verified protocol findings |

## Conventions

- Match the surrounding code: naming, comment density, terse doc comments that explain *why*.
- Keep the UI flicker-free (`PLAN.md` §4, §12). Don't re-render large regions per token.
- Cross-platform: macOS, Linux and Windows (Git Bash or PowerShell) are all supported, and CI tests all three.
- Add or update tests for behaviour changes. Use the fake CLIs; never call real accounts from tests.
- Branch from `main` and open a PR. Every merge to `main` publishes the next patch to npm automatically
  (`.github/workflows/publish.yml`), so `main` must always be releasable.
- Every config key must be changeable inside Rein, not only in the file: add it to `CONFIG_KEYS` in
  `src/store/configKeys.ts` (`/settings <key> <value>` and `/settings` → Advanced read it; a test fails on a missing key).
- Pin GitHub Actions to full commit SHAs with a version comment. The repo is scored by OpenSSF Scorecard.
- Using a new part of Codex's app-server protocol (a method, notification or field)? Add it to `REQUIRED` in
  `src/providers/codex/compat.ts`, so Rein switches Codex off cleanly on a release that lacks it instead of
  breaking mid-chat. Disabling a new Codex feature goes in `appServerArgs` (`src/providers/codex/catalog.ts`).

## Docs are part of the change

The documentation site in `site/` is the canonical user manual. **A change is not done until the docs
match it.** If you add, remove, rename, deprecate or change the behaviour of anything a user can see,
update the docs in the same PR.

### What to update

| If you change… | Update |
|---|---|
| A slash command (`src/commands/index.ts`, `src/ui/useRein.ts`) | `reference/commands.md` and the feature page |
| A CLI flag or env var (`src/app.tsx`, `src/headless.ts`) | `reference/cli.md`, `reference/files.md` (env), `features/headless.md` |
| A config key or default (`src/store/config.ts`) or a `/settings` / `/model` tab | `reference/configuration.md` and the feature page |
| A tool, its parameters or approval behaviour (`src/tools/`, `src/agents/tools.ts`, …) | `reference/tools.md`, `features/tools.md`, `features/permissions.md` if approvals change |
| Permission rules, sensitive paths, approval modes (`src/tools/host.ts`, `permissions.ts`) | `features/permissions.md`, `project/security.md` |
| Hooks, MCP, skills, AGENTS.md/CLAUDE.md loading | `features/hooks.md`, `features/mcp.md`, `features/skills.md`, `features/memory.md`, `start/from-claude-code.md` |
| Editor integration (`src/ide/`) | `features/ide.md`, `reference/commands.md` (`/ide`), `reference/tools.md` (`ide_diagnostics`) |
| Routing, failover, load balancing, compaction, decision-model thresholds | `features/routing.md`, `features/accounts.md`, `internals/*.md` |
| Goals, plans, `/btw`, rewind, subagents | the matching `features/*.md` page |
| Keyboard shortcuts, mouse, status line, sidebar | `reference/keys.md`, `features/tui.md` |
| A built-in skill (`skills/`) | `reference/commands.md`, `features/skills.md` |
| Files under `~/.rein` or `.rein/` | `reference/files.md` |
| Install requirements, supported platforms | `start/install.md`, README |
| Architecture or CLI protocol handling | `internals/architecture.md`, `internals/drivers.md` |

Pages live in `site/src/content/docs/<section>/<page>.md(x)`. A new page also needs an entry in the
`sidebar` in `site/astro.config.mjs`.

### Additions, deprecations, removals

- **Added:** document it where users will look (feature page + reference table). Don't add `New` badges to
  the sidebar; roadmap features show up on the What's new page (built from `ROADMAP.md`).
- **Deprecated:** keep the docs, add `:::caution[Deprecated]` saying what to use instead and since which
  version, and mark the reference row *(deprecated)*.
- **Removed:** delete it from every page and reference table. If a whole page goes, remove its sidebar
  entry and fix links to it (the drift check finds broken ones).
- **Changed defaults or thresholds:** update every number. Search the docs for the old value
  (`grep -rn "0.85" site/src/content/docs`).

### How to write docs here

- **The code is the source of truth.** Verify every flag, default, key name, threshold and UI string in
  `src/` before writing it down. Never document behaviour you haven't confirmed.
- Use real UI strings, and show accounts as `Claude Account 1` (privacy mode), never real emails.
- **Links between pages must be relative** (`../plans/`, `../../reference/commands/`). The site may be
  served under a base path.
- Prefer `.md` with `:::tip` / `:::note` / `:::caution` asides. Use `.mdx` only when you need Starlight
  components (`Steps`, `Tabs`, `Card`).
- Keep the README short and consistent with the site. The site has the detail.

### Checks

`node site/scripts/check-docs.mjs` fails when a slash command, alias, built-in skill, config key, tool
or CLI flag in the code is missing from its reference page, when the sidebar and the pages disagree, or
when a link between pages is broken. CI (`.github/workflows/docs.yml`) runs it and builds the site on
every PR. Passing it is the minimum: it can't tell whether the prose describes the behaviour correctly,
so read the pages you touched.

Before finishing a change, ask yourself: **"Would a user reading the docs right now be surprised by
what the code does?"** If yes, fix the docs.
