---
title: Editor integration
description: Use Rein with VS Code, Cursor, Windsurf or JetBrains through the Claude Code extension you already have. Your selection goes with your messages, file changes open as diffs in the editor, and the agent reads the editor's diagnostics.
sidebar:
  badge: New
---

Rein works with your editor through the **Claude Code extension**: the official one for VS Code, Cursor and Windsurf, or the Claude Code plugin for JetBrains IDEs. There's nothing new to install: if the extension is there, Rein uses it.

```text title="rein"
  ⎿ Connected to Visual Studio Code: your selection goes with your messages, file changes open
    as diffs there, and the agent can read its diagnostics.
```

## What you get

- **Your selection goes with your message.** Select code in the editor and ask "why is this slow?". Rein adds the selection (file, line range and text) to your next message. The top bar shows `⧉ Visual Studio Code · 12 lines` while something is selected.
- **Review changes as diffs in the editor.** When the agent wants to write or edit a file and Rein asks for approval, the same change also opens as a diff tab in the editor. Accept it there and the change goes through. Reject it, or close the tab, and it's denied. Either side can answer, whichever you reach first. **Edit the diff before accepting** and Rein writes your version, telling the agent the file now has your changes.
- **"Mention in chat" inserts `@file`.** The extension's mention action (Alt+Ctrl+K / Option+Cmd+K in VS Code) puts `@path (lines 10-20)` into Rein's input.
- **The agent sees the editor's problems.** An `ide_diagnostics` tool returns the errors and warnings the editor's language servers report (type errors, lint findings), for one file or the whole workspace. The agent can check it didn't break anything without running the whole build.

## Connecting

Rein connects on its own at startup when an editor with the extension has this project's folder open. To connect later, or to see the connection, run [`/ide`](../../reference/commands/). `/ide reconnect` reconnects.

Under the hood, the extension runs a local MCP server and announces it in `~/.claude/ide/<port>.lock` with its workspace folders and an auth token. Rein picks the editor whose workspace contains the project (preferring the one whose terminal launched it, via `CLAUDE_CODE_SSE_PORT`), checks it's still running, and connects over WebSocket with that token. This is the same protocol the `claude` CLI uses, so it works wherever the extension does.

:::note
Diffs open for writes and edits inside the project. Commands, deletes, and changes outside the project or to [sensitive paths](../permissions/#sensitive-locations) are still answered in Rein only.
:::

## Related

- [Permissions](../permissions/): approvals, which the editor diff can answer
- [Tools](../tools/): every tool the agent has
- [Coming from Claude Code](../../start/from-claude-code/)
