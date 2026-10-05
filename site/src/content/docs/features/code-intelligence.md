---
title: Code intelligence
description: Rein runs language servers itself, so every model sees type errors right after an edit and can check a file's problems, with or without an editor.
sidebar:
  badge: New
---

Rein runs language servers for your project itself, so the agent gets real compiler feedback while it works, on any model, without an editor open. After every file change the agent learns which problems **that change** introduced, and it can ask for a file's problems at any time.

## What the agent gets

- **New problems after each edit.** When `write`, `edit` or `delete` changes a file, Rein compares diagnostics before and after the change, for that file **and the files that import it**, and appends only the new ones to the tool result. So changing a function's return type reports the caller it broke:

  ```text title="edit result"
  Edited math.ts: 1 replacement at line 1

  [Diagnostics: this edit introduced 1 problem:
  main.ts:2:14 error ts 2322: Type 'string' is not assignable to type 'number'.
  Fix it before moving on.]
  ```

  Problems that were already there aren't repeated, so a legacy codebase full of warnings doesn't drown every edit. Errors and warnings count; hints don't. At most 5 are listed. Importing files are found with `git grep` for the file's name (up to 10 of them, in a git repository). Rein waits at most 1.5 seconds for the server, so a slow server never holds up an edit: a clean edit costs a few milliseconds with TypeScript 7, and up to a second with servers that only report changes (TypeScript 5/6, pyright).
- **A `diagnostics` tool.** The agent checks one file (`path`) or every file it has open. With an [editor connected](../ide/), the editor's diagnostics are used instead, and the result says which source answered.

## Languages

| Language | Server | Files |
|---|---|---|
| TypeScript / JavaScript | TypeScript 7's built-in server (`tsc --lsp`), or `typescript-language-server` for projects on TypeScript 5 or 6 | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` |
| Python | `pyright` (or `basedpyright` on your PATH) | `.py` `.pyi` |

For TypeScript, Rein uses **your project's own TypeScript** when `node_modules/typescript` exists, so the errors match your build. Otherwise it uses the TypeScript it installed.

## Installing a server

Rein looks for a server in its own folder first (`lsp/<server>/` in the [data folder](../../reference/files/)), then on your PATH. It never changes your PATH.

When a server is missing, the agent asks whether to install it and calls `lsp_install`. **That always asks you**, even in bypass mode: it installs software on your machine. Rein then runs `npm install` into `lsp/typescript/` or `lsp/python/` and records the version it installed. Nothing is installed globally.

To use a server you already have instead, set `lspServers` in `config.json`:

```json title="~/.rein/config.json"
{"lspServers": {"python": {"command": "/opt/homebrew/bin/basedpyright-langserver", "args": ["--stdio"]}}}
```

## Memory and lifetime

A server starts the first time the agent reads or changes a file in its language, one per project folder and language. [Worktree](../subagents/) subagents get their own, stopped when the worktree is merged back. A server unused for `lspIdleMinutes` (default 10) is shut down, process tree and all, and starts again when needed.

[`/lsp`](../../reference/commands/) shows the running servers with their memory use, and which languages are installed and where. `/lsp stop` stops them all now. Typical use: TypeScript 40–180 MB depending on project size, pyright about 110 MB.

To turn the feature off, set `"lsp": "off"` in `config.json`.

:::note
The server only sees what Rein tells it: the files the agent opens, reads or changes, as they are on disk. After a foreground shell command, Rein resends any open file that changed (a formatter, `sed`, `git checkout`).
:::

## Related

- [Editor integration](../ide/): your editor's diagnostics, selection and diffs
- [Tools reference](../../reference/tools/#diagnostics)
- [Configuration](../../reference/configuration/): `lsp`, `lspIdleMinutes`, `lspServers`
