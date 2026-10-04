---
title: Keeping docs current
description: How Rein keeps this site in sync with the code. The rules every PR follows, and the automated drift check that enforces them.
---

This site is the canonical user manual for Rein, and it lives in the same repository as the code
(`site/`). The rule is simple: **a change isn't done until the docs match it.** Agents and humans
follow the same process. It's written down in `AGENTS.md` (which `CLAUDE.md` imports), so Rein,
Claude Code and Codex all pick it up when they work in the repo.

## The rule

If a PR adds, removes, renames, deprecates or changes anything a user can see (a command, flag,
config key, tool, default, threshold, shortcut or UI string), it updates the matching pages in the
same PR.

| If you change… | Update |
|---|---|
| A slash command | `reference/commands.md` and its feature page |
| A CLI flag or env var | `reference/cli.md`, `reference/files.md`, `features/headless.md` |
| A config key, default, or `/settings` / `/model` tab | `reference/configuration.md` and the feature page |
| A tool or its approval behaviour | `reference/tools.md`, `features/tools.md`, `features/permissions.md` |
| Permissions, sensitive paths, approval modes | `features/permissions.md`, `project/security.md` |
| Hooks, MCP, skills, AGENTS.md / CLAUDE.md loading | the matching `features/*.md` page and `start/from-claude-code.md` |
| Routing, failover, balancing, compaction, thresholds | `features/routing.md`, `features/accounts.md`, `internals/*.md` |
| Keys, mouse, status line, sidebar | `reference/keys.md`, `features/tui.md` |
| A built-in skill | `reference/commands.md`, `features/skills.md` |

`AGENTS.md` has the full table.

## Lifecycle of a feature in the docs

- **Added:** document it on its feature page and in the reference tables. Headline features can wear
  a `New` badge in the sidebar (`sidebar: {badge: New}` in frontmatter) for a few releases.
- **Deprecated:** keep the docs, add a `:::caution[Deprecated]` aside naming the replacement and the
  version, and mark reference rows *(deprecated)*.
- **Removed:** delete it everywhere. If a page goes away, remove its sidebar entry. The drift check
  flags any links left pointing at it.
- **Changed:** search for the old value and update every mention (`grep -rn "0.85" site/src/content/docs`).

## The drift check

`site/scripts/check-docs.mjs` reads the source and fails if the docs fall behind:

- every **slash command** and alias in `src/commands/index.ts` must appear in *Slash commands*
- every **built-in skill** in `skills/` must appear in *Slash commands* and *Skills*
- every **config key** in `src/store/config.ts` must appear in *Configuration*
- every **tool** the model can call must appear in *Tool reference*
- every **CLI flag** in `src/app.tsx` and `src/headless.ts` must appear in *CLI flags*
- the **sidebar** and the **pages** must match one to one
- links between pages must be **relative** and must **resolve**

```sh
node site/scripts/check-docs.mjs
```

```text title="when something is missing"
Docs drift check failed (2):
  ✗ reference/commands: slash command /share is not documented
  ✗ reference/configuration: config key `shareTarget` is not documented

Update the docs in site/src/content/docs/ — see AGENTS.md → "Docs are part of the change".
```

CI runs it on every PR (`.github/workflows/docs.yml`) along with a full site build.

:::note
The check catches things that are *missing*. It can't tell whether the prose is *right*. That's
what review is for: the code is the source of truth, so verify each flag, default and string
against `src/` before writing it.
:::

## Writing style

- Lead with what the user gets, then show it, then explain it. Use real UI strings from the code.
- Show accounts as `Claude Account 1` (privacy mode is on by default), never real emails.
- Links between pages must be **relative** (`../plans/`) because the site can be served under a base path.
- Prefer `.md` with `:::tip` / `:::note` / `:::caution` asides. Use `.mdx` only when you need
  components like `<Steps>` or `<Tabs>`.

## Working on the site

```sh
cd site
npm ci
npm run dev      # http://localhost:4321 with live reload
npm run build    # production build in site/dist
```

Pages live in `site/src/content/docs/<section>/<page>.md(x)`. The sidebar is in
`site/astro.config.mjs`, the landing page is `site/src/pages/index.astro`, and the theme is
`site/src/styles/`.
