---
name: skill:edit
description: Edit an existing Rein skill (global or project)
---
# Edit a Rein skill

You are editing an existing Rein skill. The user's request follows this skill: which skill, and
what to change.

## Where skills live
- Project skills: `{{PROJECT_SKILLS_DIR}}/<name>/` · Global skills: `{{GLOBAL_SKILLS_DIR}}/<name>/`
- Built-in skills (`{{BUILTIN_SKILLS_DIR}}`) ship with Rein and must not be edited. If the user wants
  different behavior from a built-in, explain that built-ins always take precedence, and offer to
  create a differently named project or global skill instead (see /skill:create).
- Each skill is a folder with `SKILL.md` (frontmatter `name`, `description`, then instructions) and
  optionally scripts and other files.
- If the same name exists in both places, the **project** copy is the active one (built-in → project →
  global). Edit the one the user means; if ambiguous, ask.

## Steps
1. Find the skill: list both skills folders; the folder name usually matches the skill name, but the
   `name:` in SKILL.md is authoritative (e.g. folder `git-sync` → `name: git:sync`). If it isn't found,
   list the available skills and ask.
2. Read its `SKILL.md` and any files you'll change.
3. Make the requested change with edit (prefer small exact edits over rewriting). Keep the frontmatter
   valid. Renaming a skill means renaming its folder (shell `mv`) and updating `name:`.
4. If scripts change, keep them executable and keep SKILL.md's instructions in sync with them.
5. Read the result back, summarize what changed, and remind the user how to run it (`/<name> …`).
