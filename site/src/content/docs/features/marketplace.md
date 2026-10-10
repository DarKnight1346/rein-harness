---
title: Marketplace
description: Add tools, commands, skills, themes, features and bundles to Rein from marketplace repos, through a store inside Rein.
---

A marketplace is a git repo laid out as a catalog. `/marketplace` opens every item from every marketplace you've added in one store: browse by category, search, read an item's page, and install it with Enter.

The official **Rein Marketplace** ([github.com/rein-harness/rein-marketplace](https://github.com/rein-harness/rein-marketplace)) is always there. Add any other repo laid out the same way, including one of your own or your team's.

## The store

`/marketplace` opens the store (fullscreen):

```text
 [All]   Tools    Commands    Skills    UI    Features    Bundles    Installed (2)
 Search: type to search  · 14 items in 1 marketplace

 ❯ ✦ Conventional commits 1.0.0 ✓      Conventional commits 1.0.0 · by Rein
   ▭ Focus layout 1.0.0                 Skills · Rein Marketplace
   ⟳ CI and pull requests 1.0.0
   ⚒ Playwright browser 1.0.0           /conventional-commits:commit writes a Conventional Commits
   ◐ Midnight 1.0.0                     message for what's staged, and commits after you approve it.
                                        Adds: 1 skill
                                        [ Reinstall ]  [ Uninstall ]
```

| Key | |
|---|---|
| `←` `→` | Category: All, Tools, Commands, Skills, UI, Features, Bundles, Installed |
| typing | Searches names, descriptions, tags and authors (Esc clears it) |
| `↑` `↓` | Picks an item; its page shows on the right |
| Enter | Installs it, or updates it when the marketplace has a newer version (`↑ 1.1.0` in the list) |
| Ctrl+D | Uninstalls it |
| Ctrl+R | Fetches every marketplace again |
| Esc | Closes the store |

Each page says what the item adds: skills, commands, subagents, tools from MCP servers, hooks, a theme, a layout or packs. An item that runs code on your machine (MCP servers or hooks) says so in yellow. Install those only from a source you trust, as with any plugin.

In the classic renderer, `/marketplace` prints the catalog instead.

## Commands

| Command | What it does |
|---|---|
| `/marketplace` | Opens the store |
| `/marketplace add <gitRepoUrl>` | Adds a marketplace (`https://github.com/owner/repo`, `owner/repo`, an SSH URL, or a folder on this machine). Rein clones it and checks it's a marketplace |
| `/marketplace list` | The marketplaces you've added, the official one first |
| `/marketplace remove <gitRepoUrl>` | Removes one. Items you installed from it stay installed. The official marketplace can't be removed |
| `/marketplace update` | Fetches every marketplace again, then lists the items you installed that have a newer version: **All** and each item are ticked, `Space` unticks or ticks one, Enter updates what's ticked (fullscreen; the classic renderer prints the list) |
| `/marketplace update all` | Updates every installed item that has a newer version |
| `/marketplace update <id> [<id>…]` | Updates just those |
| `/marketplace install <id>` | Installs an item (and what it needs) without opening the store |
| `/marketplace uninstall <id>` | Uninstalls an item |

Rein refreshes a marketplace's copy in the background when you open the store and it's more than a day old.

## What an item can be

| Category | What it adds |
|---|---|
| **Tools** | MCP servers (`.mcp.json`), so the agent gets their tools |
| **Commands** | Slash commands (`commands/*.md`), as `/<item>:<name>` |
| **Skills** | Skills (`skills/<name>/SKILL.md`), as `/<item>:<name>` and for the agent |
| **UI** | A theme (the accent colour of the input box, window frames and selections) or a layout for the status line and sidebar |
| **Features** | Settings: [packs](../../reference/commands/#packs) or [experiments](../../reference/configuration/#experiments) it turns on |
| **Bundles** | Other items, installed together |

An item can also bring subagents (`agents/*.md`) and [hooks](../hooks/) (`hooks/hooks.json`). Installed items live in `~/.rein/plugins/<id>/` and load exactly like [plugins](../plugins/): commands, skills and subagents right away; MCP servers and hooks the next time Rein starts. Skills from items you install show in the bare `/` list (other plugins' show once you type).

Uninstalling removes the item and undoes what it changed: the packs and experiments it turned on, and the theme or layout it set. If you changed those yourself since, yours stay.

## Making a marketplace

Any git repo laid out like this is a marketplace:

```text
marketplace.json          {"name": "My Marketplace", "description": "…"}
items/<id>/rein.json      the item (below)
items/<id>/README.md      its page in the store
items/<id>/skills/<name>/SKILL.md, commands/*.md, agents/*.md, hooks/hooks.json, .mcp.json
```

`rein.json`:

| Field | |
|---|---|
| `id`, `name`, `version`, `description` | Required. A new `version` shows as an update to people who installed it |
| `author`, `icon`, `tags`, `homepage` | Shown in the store. `icon` is one or two characters, like `✦` |
| `category` | `tools`, `commands`, `skills`, `ui`, `feature` or `bundle`. Left out, Rein picks one from what the item adds |
| `requires` | Other items (same marketplace) installed with this one, so a bundle is an item with `requires` |
| `config` | Settings it turns on: `{"packs": ["ci"], "experiments": ["…"]}`, or a layout: `{"statusLine": [...], "sidebarSections": [...]}` |
| `theme` | `{"accent": "#a78bfa"}` |

```json title="items/theme-midnight/rein.json"
{"id": "theme-midnight", "name": "Midnight", "version": "1.0.0", "description": "A violet accent.", "category": "ui", "theme": {"accent": "#a78bfa"}}
```

A **Claude Code marketplace** works too: a repo with `.claude-plugin/marketplace.json` whose plugins are folders of the repo (`"source": "./plugins/name"`). Plugins it points at in other repos aren't fetched.

## Related

- [Plugins](../plugins/): what Rein loads from Claude Code and Codex
- [Skills](../skills/)
- [Slash commands](../../reference/commands/)
