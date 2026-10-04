---
title: Memory & instructions
description: What Rein's agents know before you type — project memory the agent keeps itself, AGENTS.md and CLAUDE.md instruction files, folder-scoped instructions, and a custom base prompt.
---

Every session starts already knowing your build command, your conventions, and that thing about the flaky integration test. Some of that comes from the files you write (`AGENTS.md`, `CLAUDE.md`), and some comes from a project memory the agent keeps for itself. It's a plain markdown file you can read and edit.

```text title="rein"
› the e2e tests need the docker stack running first — remember that

⏺ Remember(E2E tests need `docker compose up -d` running first)
  Remembered for this project (7 facts in .rein/MEMORY.md).
```

## Project memory

Project memory lives in `<project>/.rein/MEMORY.md`. Each fact is one bullet with the date it was learned:

```markdown title=".rein/MEMORY.md"
# Project memory

Things learned while working on this project, kept by Rein (edit freely).

- Build with `pnpm build`; `npm` breaks the workspace links (2026-09-12)
- E2E tests need `docker compose up -d` running first (2026-10-03)
- API handlers live in src/routes/, one file per resource (2026-10-01)
```

The facts are put into the system prompt of every session in this project, subagents included, under **Project memory**, with the instruction to rely on them and keep them current. If memory is empty, the agent is prompted to start saving things.

### remember and forget

The agent maintains memory with two tools:

- **`remember`** adds one concise fact. It's meant for build/test commands, conventions, architecture decisions, gotchas and your stated preferences for the project, and not for secrets, temporary state, or things obvious from the code. Duplicates are detected (case-insensitive, ignoring the date).
- **`forget`** removes every fact containing the given text (case-insensitive, at least 3 characters).

Neither tool asks for approval: they write only to this one file, and the change shows in the transcript. Memory is capped at **32 KB**. Past that, `remember` fails with `project memory is full (32 KB) — forget outdated facts first`.

You can also ask directly: "remember that we deploy from the `release` branch", "forget the note about Node 18".

### /memory

`/memory` prints the current facts and the file's path:

```text title="rein"
Project memory (~/code/app/.rein/MEMORY.md):
• Build with `pnpm build`; `npm` breaks the workspace links (2026-09-12)
• E2E tests need `docker compose up -d` running first (2026-10-03)
The agent adds and removes facts itself; you can also edit the file.
```

:::caution[Keep it to bullets]
Rein reads only lines starting with `- ` or `* ` as facts. When the agent next calls `remember` or `forget`, the file is rewritten as the standard header plus those bullets, so any headings or prose you added by hand are dropped. Edit freely, but keep each fact as a bullet.
:::

Whether to commit `.rein/MEMORY.md` is up to you. Committed, it works as shared team knowledge; ignored, it stays personal.

## Instruction files

Rein reads the open `AGENTS.md` standard **and** Claude Code's `CLAUDE.md`, so a repo set up for either works without changes. Each file found becomes its own section of the system prompt, labelled with its path, most general first:

1. `~/.rein/AGENTS.md`: your instructions for every project.
2. `~/.claude/CLAUDE.md`: your Claude Code user instructions.
3. For each folder from the **git root** down to the folder you launched `rein` in: `AGENTS.md`, then `CLAUDE.md`, then `.claude/CLAUDE.md`.

```text
~/code/monorepo/              ← git root
├── AGENTS.md                 ③ loaded
├── CLAUDE.md                 ③ loaded (unless identical to AGENTS.md)
└── services/
    └── billing/              ← you ran `rein` here
        ├── AGENTS.md         ③ loaded
        └── src/
            └── AGENTS.md     → scoped (see below)
```

Details:

- Each file is capped at **64 KB** (the rest is cut off).
- Files with identical contents are included once, so a `CLAUDE.md` that's a symlink to or copy of `AGENTS.md` doesn't double up.
- Without a git repository, the walk goes up to the filesystem root, so an `AGENTS.md` in your home folder or a parent folder applies too.
- `CLAUDE.local.md` isn't read, and `@path` imports inside these files aren't expanded.

## Scoped subfolder instructions

Instruction files **below** the launch folder aren't loaded up front. When the agent first works in a subfolder, through `read`, `list`, `search`, `write`, `edit`, `delete`, `image_generate` or a shell `cwd`, Rein attaches that folder's instruction files (and those of every folder between) to the tool result, marked with where they apply:

```text
<scoped_instructions file="src/legacy/AGENTS.md" applies_to="src/legacy/">
These instructions apply ONLY to files under src/legacy/ — follow them when working there, not elsewhere.

Don't modernize this code. Match the existing ES5 style; no arrow functions.
</scoped_instructions>
```

That way a monorepo can hold per-package rules without spending context on packages the agent never touches. Each file is delivered **once per conversation**. Rein delivers them again after `/clear`, `/resume` or [compaction](../../internals/context/), since a summary may not keep them word for word.

## Custom base prompt: `~/.rein/system-prompt.md`

The system prompt starts with a short base section:

```text
You are Rein, a coding assistant working in the user's project from a terminal chat.
- Be direct and concise. Lead with the answer.
- Output renders as plain text in a terminal: prefer short paragraphs and simple lists; use code blocks for code.
```

If `~/.rein/system-prompt.md` exists and isn't empty, its contents **replace that base section only**. Everything after it is still added: the tools guidance, the project root and working directories, the scratchpad, session search, project memory and your instruction files. You can change the agent's voice or persona without breaking the tools or losing your `AGENTS.md`.

```markdown title="~/.rein/system-prompt.md"
You are a senior engineer pairing with the user in their terminal.
- Answer first, then explain only what's non-obvious.
- Prefer small, reviewable changes. Mention any test you didn't run.
```

:::tip[Which one to use]
- **Facts about this project** the agent discovers → project memory.
- **Rules for this repo** your team agrees on → `AGENTS.md` / `CLAUDE.md` (committed).
- **Rules for one package or folder** → an `AGENTS.md` in that folder (scoped).
- **Your personal preferences everywhere** → `~/.rein/AGENTS.md`.
- **The agent's voice and style** → `~/.rein/system-prompt.md`.
- **A procedure you run on demand** → a [skill](../skills/).
:::

## Related

- [Skills](../skills/): instructions loaded on demand
- [Context](../../internals/context/): how the system prompt counts toward the window
- [Files reference](../../reference/files/): every file Rein reads
- [Coming from Claude Code](../../start/from-claude-code/)
