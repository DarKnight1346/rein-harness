---
title: Skills
description: Package instructions, scripts and templates as a folder, run them as /name, and let any model load them when a task matches — compatible with the SKILL.md format.
---

A skill is a folder holding a `SKILL.md`, plus any scripts, templates or reference files the job needs. Type `/release 1.4.0` and the agent follows your release checklist, using the helper script you keep next to it. You don't have to type the slash command, either: when you ask for something a skill covers, the model can load it on its own.

```text title="rein"
› /changelog since v1.3.0

⏺ Skill(changelog)
⏺ Shell($ git log v1.3.0..HEAD --pretty=format:%s)
⏺ Read(CHANGELOG.md)
⏺ Edit(CHANGELOG.md) · you approved
```

## Where skills live

| Source | Folder | Scope |
|---|---|---|
| **Built-in** | `<rein install>/skills/` | Ships with Rein, can't be changed |
| **Project** | `<project>/.rein/skills/<name>/` | This project (commit it to share with your team) |
| **Global** | `~/.rein/skills/<name>/` | Every project |

On a name clash, **built-in wins, then project, then global**. A project skill hides a global one with the same name, and nothing can replace a built-in. Rein's own commands (`/help`, `/model`, `/goal`, …) beat skills too. If a skill is hidden by a command, Rein says so at startup: `Skill "help" hidden by built-in command; rename to use it.`

Skills are rescanned each time you start typing a `/` command, so a new or edited skill shows up without restarting.

## Anatomy of a skill

```text
.rein/skills/changelog/
├── SKILL.md          ← required: frontmatter + instructions
├── config.json       ← optional
├── template.md
└── scripts/
    └── contributors.sh
```

### SKILL.md

```markdown title=".rein/skills/changelog/SKILL.md"
---
name: changelog
description: Draft the next CHANGELOG.md entry from git history
---
# Write the changelog entry

1. Run `git log <since>..HEAD --pretty=format:%s` (the user gives `<since>`; default: the latest tag).
2. Group commits into Added / Changed / Fixed, following {{SKILL_DIR}}/template.md.
3. ...
```

The frontmatter is optional, and Rein reads two fields from it:

- `name`: the slash name. It's lowercased, and anything outside letters, digits, `-`, `_` and `:` becomes `-`. Defaults to the folder name.
- `description`: one line, shown in the `/` autocomplete and in the `skill` tool's list. Defaults to the first non-heading line of the instructions.

Everything after the frontmatter is the instruction text the agent follows. A skill with an empty body is skipped.

### config.json

Every field is optional and falls back to the frontmatter, then to the defaults:

```json title=".rein/skills/git-sync/config.json"
{
  "name": "git:sync",
  "description": "Rebase on main, run the tests, push",
  "main": "PROMPT.md",
  "aliases": ["gs", "sync"],
  "planMode": false
}
```

| Field | Meaning |
|---|---|
| `name` | Slash name. Use a `group:` namespace like `git:sync`; folder names can't contain `:`, so name the folder `git-sync`. |
| `description` | One-line description. |
| `main` | The instructions file, if it's not `SKILL.md`. It must be inside the folder; if it's missing, Rein falls back to `SKILL.md` (or `skill.md`). |
| `aliases` | Extra slash names (`/gs`). An alias never overrides another skill's real name or a Rein command. |
| `planMode` | `true` turns [plan mode](../plans/) on when the skill runs: the agent explores read-only and must present a plan before changing anything. The built-in `/plan` and `/plan:deep` work this way. |

### Placeholders

When a skill runs, these placeholders in its instructions are replaced with real paths:

| Placeholder | Becomes |
|---|---|
| `{{SKILL_DIR}}` | This skill's folder, for referencing bundled scripts and templates |
| `{{PROJECT_SKILLS_DIR}}` | `<project>/.rein/skills` |
| `{{GLOBAL_SKILLS_DIR}}` | `~/.rein/skills` |
| `{{BUILTIN_SKILLS_DIR}}` | Rein's built-in skills folder |

The agent is also told the skill's folder path and the files in it (up to 50, hidden files skipped), so it knows what it can run or read.

## How skills run

**You run one** as `/name arguments`. Rein sends the agent a turn shaped like this:

```text
<skill name="changelog" source="project" dir="/…/.rein/skills/changelog">
# Write the changelog entry
…instructions, placeholders filled…
Files in this skill's folder (/…/.rein/skills/changelog): SKILL.md, scripts/contributors.sh, template.md
</skill>

since v1.3.0
```

With no arguments, the last line is `Follow the skill above.` If the agent is busy, the skill is queued and runs when it finishes. If you're viewing a subagent, the skill runs there.

**The model runs one** through the `skill` tool. That tool's description lists every installed skill with its source and description, and the model is told to load a matching skill before starting. It gets the same text back, and a `planMode` skill switches plan mode on in this case too. The tool is hidden when no skills are installed.

Skill instructions don't bypass anything: the agent still uses its normal tools, under your [permissions](../permissions/).

## Built-in skills

| Skill | What it does |
|---|---|
| `/plan <task>` | Plan mode on. Restate the goal, explore read-only (with subagents for wide areas), ask clarifying questions with `ask_user`, then present a plan with 2–10 checkable milestones. |
| `/plan:deep <task>` | The thorough version for big or risky work: broader exploration with parallel subagents, more questions, an [advisor](../subagents/) review of the approach *and* of the draft plan (when an advisor is configured), risks, rollback, and 3–10 milestones. |
| `/skill:create <what>` | The agent writes a new skill for you, project or global. |
| `/skill:edit <which, what>` | The agent edits an existing project or global skill. Built-ins are off-limits; it offers to make a differently named copy instead. |

## Write your first skill

Here's a project skill that runs your pre-PR checks and summarizes the failures.

**1. Create the folder and SKILL.md**

```markdown title=".rein/skills/preflight/SKILL.md"
---
name: preflight
description: Run lint, typecheck and tests; report what fails and why
---
# Preflight checks

Run the project's checks before a pull request and report the results.

1. Run `{{SKILL_DIR}}/check.sh` with the shell tool (foreground, timeout_ms 600000).
   It runs each check and prints a `== <name>: PASS|FAIL ==` header before its output.
2. For every FAIL, read the relevant files and work out the root cause. Don't fix anything yet.
3. Reply with a table: check · result · one-line cause. Then list suggested fixes in priority order.
4. If the user's request (after this skill) says "fix", fix the failures one at a time,
   re-running only the failing check after each fix.
```

**2. Add the script it calls**

```sh title=".rein/skills/preflight/check.sh"
#!/usr/bin/env bash
# Each check runs even if an earlier one fails.
for check in "lint:npm run lint" "types:npx tsc --noEmit" "tests:npm test"; do
  name=${check%%:*}; cmd=${check#*:}
  if out=$($cmd 2>&1); then echo "== $name: PASS =="; else echo "== $name: FAIL =="; fi
  echo "$out" | tail -n 60
done
```

```sh
chmod +x .rein/skills/preflight/check.sh
```

**3. Run it**

```text title="rein"
› /preflight
› /preflight fix
```

Rein starts showing `/preflight` in the autocomplete as soon as you type `/`. The first run asks before executing `check.sh` (it's a shell command). Choose **3 Always allow** to save a `shell(...)` rule for it in `.rein/settings.json`.

:::tip
Write instructions *to the agent*: imperative, specific, with concrete commands and the expected output. Put anything long or reusable, such as templates, checklists and scripts, in files next to SKILL.md and reference them with `{{SKILL_DIR}}`.
:::

### Or let the agent write it

```text title="rein"
› /skill:create a global skill "pr-desc" that writes a PR description from the current branch's diff against main
```

`/skill:create` works out a name and scope (and asks if either is unclear), checks the name isn't taken, writes `SKILL.md` and any scripts (marking them executable), reads the result back, and tells you how to run it. `/skill:edit` does the same for changes, preferring small edits and renaming the folder when you rename a skill.

Writing to `~/.rein/skills` doesn't trigger an outside-the-project prompt, because the global skills folder is always a working directory.

## Related

- [Plans](../plans/): what `planMode` skills turn on
- [Commands reference](../../reference/commands/)
- [Memory](../memory/): always-on instructions instead of on-demand ones
- [Files reference](../../reference/files/)
