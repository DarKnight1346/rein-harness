---
title: Plugins
description: Plugins you installed with Claude Code or Codex work in Rein as they are, including their commands, skills, agents, hooks and MCP servers.
---

Install a plugin with Claude Code (`claude plugin install …`) or Codex (`codex plugin add …`) and Rein picks it up. There's nothing to configure and nothing is copied: Rein reads the plugin where the CLI installed it.

Items you install from the [marketplace](../marketplace/) are plugins too (`~/.rein/plugins/`), listed as `Marketplace` and loaded the same way; on a name clash they win over Claude Code's and Codex's.

```text title="rein"
› /plugins

  ⎿ review-kit 1.2.0 · Claude Code · 2 commands, 1 agent, 1 hook event, 1 MCP server
      /review-kit:pr  /review-kit:lint
    work-pets 0.1.6 · Codex · 3 commands
      /work-pets:create-pet  /work-pets:pets  /work-pets:update-pet
    Codex skills: /deploy
```

## What a plugin brings

| In the plugin | In Rein |
|---|---|
| `commands/*.md` | Slash commands named `/<plugin>:<command>`. `$ARGUMENTS`, `$1`… and `` !`cmd` `` work as in Claude Code. |
| `skills/<name>/SKILL.md` | [Skills](../skills/) named `/<plugin>:<skill>`, which the model can also load on its own when a task matches. |
| `agents/*.md` | Named [subagents](../subagents/) (`<plugin>:<agent>`). |
| `hooks/hooks.json` | [Hooks](../hooks/), run like the hooks in your own settings. |
| `.mcp.json` | [MCP servers](../mcp/) named `<plugin>-<server>`, listed in `/mcp` with the source "plugin". |

`${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` are replaced with the plugin's folder everywhere, so a plugin's scripts are found wherever it's installed. A manifest (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) can point `commands`, `agents`, `skills`, `hooks` and `mcpServers` somewhere other than the default folders, but never outside the plugin's own folder.

## Which plugins are loaded

- **Claude Code:** the plugins in `~/.claude/plugins/installed_plugins.json`. A plugin turned off in `enabledPlugins` (in `~/.claude/settings.json`, the project's `.claude/settings.json` or `.claude/settings.local.json`; later files win) is skipped, and so is one whose manifest says `"defaultEnabled": false` and that isn't turned on. A plugin installed for one project only is loaded only in that project.
- **Codex:** the plugins Codex installed under `~/.codex/plugins/cache/`, the newest version of each, unless `config.toml` turns one off (`[plugins."name@marketplace"]` with `enabled = false`). This matches what `codex plugin list` shows as "installed, enabled".
- **Codex skills** without a plugin load too: `~/.codex/skills/`, `~/.agents/skills/` and the project's `.agents/skills/`. Codex's own built-in `.system` skills are skipped.

If two plugins share a name, the Claude Code one wins. Your own skills, commands and agents always win over a plugin's.

:::caution[Installing a plugin is your consent to run it]
A plugin's hooks and MCP servers start without a separate Rein prompt, as they do in Claude Code and Codex. Installing the plugin was the decision. Only install plugins from sources you trust, and use `/plugins` to see what each one adds. (A **project's** own hooks and `.mcp.json` are different: Rein asks before trusting those, because cloning a repo isn't consent.)
:::

## Gotchas

- Changes show up the next time Rein loads commands (start, or type `/` again after a few seconds). Nothing needs a restart.
- Codex plugins that are ChatGPT "apps" or connectors (`.app.json`) only work inside ChatGPT. Rein loads their skills, not the apps.
- A plugin's hooks run in your session, outside the [command sandbox](../permissions/#the-command-sandbox), like your own hooks.

## Related

- [Skills](../skills/) · [Hooks](../hooks/) · [MCP servers](../mcp/) · [Subagents](../subagents/)
