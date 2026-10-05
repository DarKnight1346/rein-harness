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

  Problems that were already there aren't repeated, so a legacy codebase full of warnings doesn't drown every edit. Errors and warnings count; hints don't. At most 5 are listed. Importing files are found with `git grep` for the file's name: up to 10, and only files git tracks, so a caller created moments ago and not yet added isn't checked. Each wait for the server is capped at 1.5 seconds, so a slow server never holds up an edit for long. The first edit in a session can take a few seconds while the server starts. After that, a clean edit costs a few milliseconds with TypeScript 7, and up to about a second with servers that only report changes (TypeScript 5/6, pyright).
- **A `diagnostics` tool.** The agent checks one file (`path`) or every file it has open. With an [editor connected](../ide/), the editor's diagnostics are used instead, and the result says which source answered. The after-edit check always uses Rein's own servers, so with an editor open you have two language servers running for the project (the editor's and Rein's).

## Languages

Rein knows a language server for most languages you'll work in. It starts the right one for each file. If that server isn't installed, the agent mentions it **once** the first time it changes such a file, so it can offer to install it.

**Rein installs these itself** (when you say yes), into its own folder:

| Language | Server | Installed with | Error reporting |
|---|---|---|---|
| TypeScript / JavaScript | TypeScript 7's `tsc --lsp`, or `typescript-language-server` for TypeScript 5/6 | npm | ✓ |
| Python | `pyright` (or `basedpyright` on your PATH) | npm | ✓ |
| C / C++ / Objective-C / CUDA | `clangd` | release binary | ✓ |
| Assembly (GNU as, NASM, x86/x86-64, ARM, RISC-V…) | `asm-lsp` | release binary (macOS, Linux x64) | ✓ |
| Go | `gopls` | `go install` | ✓ |
| Zig | `zls` | release binary | ✓ |
| Lua | `lua-language-server` | release binary | ✓ |
| PHP | `intelephense` | npm | ✓ |
| Clojure | `clojure-lsp` | release binary | ✓ |
| Elm | `elm-language-server` | npm | ✓ |
| Svelte | `svelte-language-server` | npm | ✓ |
| CSS / SCSS / Less, JSON, YAML | `vscode-langservers-extracted`, `yaml-language-server` | npm | ✓ |
| TOML | `taplo` | release binary | ✓ |
| Dockerfile | `dockerfile-language-server` | npm | ✓ |
| Rust | `rust-analyzer` | release binary | Started; reported nothing without the Rust toolchain, which it needs (`rustup`) |
| Shell scripts | `bash-language-server` | npm | Started; its errors come from [`shellcheck`](https://www.shellcheck.net), which must be on your PATH |
| Ruby | `ruby-lsp` | `gem` | Not tested (needs Ruby 2.7 or newer) |
| C# / F# | `csharp-ls` / `fsautocomplete` | `dotnet tool` | Not tested (needs the .NET SDK) |
| Fortran | `fortls` | Python venv | Started; didn't report the test error |
| Vue | `@vue/language-server` | npm | Started; didn't report a script type error (that needs Vue's TypeScript plugin, which Rein doesn't set up) |
| HTML, Markdown | `vscode-html-language-server`, `marksman` | npm, release binary | Started; didn't report the test errors (an unclosed tag, a broken link) |
| SQL | `sqls` | `go install` | Started; it checks against a database connection you configure |
| CMake | `neocmakelsp` | release binary | Started (not tested with an error) |

✓: tested on macOS. Rein installed it, opened a file with a deliberate error, and the error came back. "Started": installed and ran, but didn't report that test's error.

**These come with their toolchain**, so Rein uses them when they're on your PATH and tells you how to get them otherwise: Swift (`sourcekit-lsp`, with Xcode, found through `xcrun`), Java (`jdtls`), Kotlin, Scala (Metals), Haskell (HLS), OCaml, Elixir, Erlang, Gleam, Dart / Flutter, Nim, R, Julia, Perl, PowerShell, Terraform and Nix.

For TypeScript, Rein uses **your project's own TypeScript** when `node_modules/typescript` exists, so the errors match your build. Otherwise it uses the TypeScript it installed.

:::tip[C and C++ projects]
clangd needs to know how your code is built (include paths, defines, target) to report errors you can trust. Give it a `compile_commands.json` in the project or `build/`: CMake writes one with `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON`; for Make and other builds, run the build through [Bear](https://github.com/rizsotto/Bear) (`bear -- make`). Without one, clangd guesses, and freestanding code (kernels, firmware) shows false errors. Rein only reports problems an edit introduced, which keeps the noise down. For assembly, an `.asm-lsp.toml` in the project picks the assembler and architecture.
:::

## Installing a server

Rein looks for a server in its own folder first (`lsp/<server>/` in the [data folder](../../reference/files/)), then on your PATH. It never changes your PATH.

When a server is missing, the agent asks whether to install it and calls `lsp_install`. **That always asks you**, even in bypass mode: it installs software on your machine. Rein installs the latest version into `lsp/<server>/` and records the version:

- **npm** packages go into that folder's `node_modules`.
- **Release binaries** are downloaded from the project's GitHub releases page and unpacked there. An update unpacks next to the old version first, so a failed download keeps the working one.
- **`go install`, `gem install`, `dotnet tool install`** and Python packages (in a venv) use that language's own tool, which the project already needs.

Nothing is installed globally. `/lsp` lists what's available and where, what Rein can install, and what you'd install yourself.

To use a server you already have instead, or one Rein doesn't know, set `lspServers` in `config.json` (by server id, as `/lsp` shows them):

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
