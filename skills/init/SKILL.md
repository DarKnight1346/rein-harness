---
name: init
description: Write or improve this project's AGENTS.md from a look at the code
---
# Write the project's AGENTS.md

Create (or improve) `AGENTS.md` at the project root: the instructions Rein, Claude Code, Codex and
other agents read before working here. Anything the user wrote after `/init` is extra guidance; follow it.

## 1. Look before you write
Explore read-only first. Use subagents in parallel for a big repository.
- README, contributing guides, existing `AGENTS.md` / `CLAUDE.md` / `.cursorrules` /
  `.github/copilot-instructions.md`. Keep what's still true in them.
- How to build, run, test (and run a single test), lint and format: `package.json` scripts,
  `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, CI workflows. **Only list commands that exist.**
- The layout: the main folders and what lives where, entry points, generated or vendored code to leave alone.
- Conventions visible in the code: language versions, style, naming, test layout, error handling,
  commit/PR rules from CI or contributing docs.

## 2. Write it
- Short and specific: what a capable newcomer couldn't guess in five minutes. No generic advice
  ("write clean code"), no long file listings, no secrets.
- Suggested sections (skip empty ones): what the project is (2–3 lines) · Commands · Map ·
  Conventions · Gotchas.
- If `AGENTS.md` exists, edit it in place: fix what's wrong, add what's missing, keep the user's own rules.
- If there's a `CLAUDE.md` but no `AGENTS.md`, put the shared instructions in `AGENTS.md` and leave
  `CLAUDE.md` as a one-line `@AGENTS.md` import (Claude Code reads that; Rein reads both).

## 3. Finish
Read the file back, check every command and path you wrote against the repo, then give the user a
short summary of what you wrote or changed.
