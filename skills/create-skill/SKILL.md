---
name: skill:create
description: Create a new Rein skill (global or for this project)
---
# Create a Rein skill

You are creating a new skill for Rein. The user's request follows this skill; it may name the skill,
describe what it should do, and say whether it's global or project-only.

## How Rein skills work
- A skill is a **folder** named after the skill containing at least `SKILL.md`. It can also carry
  scripts (bash, Python, …), templates, reference docs or any other files the skill needs.
- `SKILL.md` starts with frontmatter, then the instructions the agent follows when the skill runs:
  ```
  ---
  name: my-skill
  description: One line shown in the / command list
  ---
  # Instructions written to the agent, imperative, specific…
  ```
- Optional `config.json` in the folder, e.g. `{"main": "SKILL.md", "aliases": ["gs"], "name": "git:sync",
  "description": "…"}`. Every field is optional and falls back to the main file's frontmatter, then to
  the defaults (main file `SKILL.md`, the folder name, the first line of the instructions). Aliases add
  extra `/` names; they never override another skill's name or a Rein command. Only add config.json
  when the user wants aliases or a different main file.
- Locations — the user picks the scope:
  - **Project** (only this project): `{{PROJECT_SKILLS_DIR}}/<name>/SKILL.md`
  - **Global** (every project): `{{GLOBAL_SKILLS_DIR}}/<name>/SKILL.md`
  - Built-in skills ship with Rein and can't be created or changed.
- Name conflicts resolve **built-in → project → global**: a project skill hides a global one with the
  same name, and nothing can replace a built-in. Built-in commands (/help, /model, …) also win.
- The user runs a skill as `/<name> [arguments]`; the arguments arrive after the skill text. When it
  runs, the agent is told the skill's folder path and its files, and SKILL.md may use the
  placeholder `{{SKILL_DIR}}` (written with double braces) for that folder.

## Steps
1. Work out the **name** (lowercase letters/digits/hyphens; an optional `group:` namespace like
   `git:sync` is fine — then name the folder `git-sync` and put `name: git:sync` in the frontmatter,
   since folder names shouldn't contain `:`), a one-line **description**, the
   **scope** (project or global) and what the skill should do. If the scope or the purpose is unclear,
   ask the user before creating anything. Default to project scope when they say "for this project".
2. Check the name isn't taken: list the global and project skills folders (read each SKILL.md's
   `name:` when folder names differ), and avoid built-in names (`skill:create`, `skill:edit`) and Rein
   command names.
3. Create `<scope dir>/<folder>/SKILL.md` with the write tool. Write instructions for an AI agent:
   concrete steps, what to check, expected output; reference bundled files as
   `{{SKILL_DIR}}/<file>`.
4. If the skill needs scripts, write them into the same folder (e.g. `scripts/run.sh`), make them
   executable with the shell tool (`chmod +x`), and tell SKILL.md exactly how to call them.
5. Read SKILL.md back to verify, then tell the user the skill's path and how to run it
   (`/<name> …`). New skills show up in the `/` list immediately.
