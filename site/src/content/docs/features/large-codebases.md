---
title: Large codebases
description: Getting an agent the right context in a codebase too big to read. Context packs, maps of the code and its owners, org-scale search, and checkouts of only what you need.
---

In a codebase of millions of lines, the hard part isn't writing the change: it's finding the twenty files that matter. These features get the agent to them without reading everything.

## Context packs

You probably hand the agent the same files again and again: "the payments flow" is these services, this schema and that doc. Save them once as a **context pack**:

```text title="rein"
> /pack save payments "services/payments/**" db/schema/payments.sql docs/payments.md
  ⎿ Saved context pack "payments" in .rein/packs.yaml. /pack payments attaches it.

> /pack payments add refunds older than 30 days
```

`/pack <name> [message]` attaches every file the pack names, exactly like typing each `@path` (up to 40 files), and sends your message with them. Without a message the agent reads them and waits. `/pack` lists the packs.

Packs live in `.rein/packs.yaml`, so you can commit them for the team:

```yaml title=".rein/packs.yaml"
payments:
  files: ["services/payments/**", "db/schema/payments.sql", "docs/payments.md"]
  note: The payments flow end to end
users: ["services/users/**"]
```

Globs are relative to the project (`*`, `**`, `?`, `{a,b}`) and match the files git doesn't ignore.

## A map of the repo

`/map` lists each source file's top-level declarations (functions, classes, types, constants), one line each, as much as fits in about 4,000 tokens:

```text title="rein"
> /map
  ⎿ Repo map (412 of 1,830 files with declarations, top-level declarations only):
    services/payments/charge.ts
      export async function charge(order: Order, card: Card): Promise<Receipt>
      export class ChargeError extends Error
    …
```

`/map send` gives the whole map to the agent. With the `repo-map` [experiment](../../reference/configuration/#experiments) on, the agent gets a [`repo_map`](../../reference/tools/#repo_map) tool to ask for it (or for one folder, with a larger budget) when it starts in an unfamiliar codebase.

Files are ranked by how much they export, then by how shallow they sit, and filled in until the budget runs out. Tests, vendored and generated files (`node_modules/`, `vendor/`, `dist/`, `*.pb.go`, `*.min.js`…) are left out, and only the first 5,000 source files are read. The declarations come from the same pattern as the outlines of long files (the `outline-reads` [experiment](../../reference/configuration/#experiments)), so they work across most languages without a parser or language server.

## Related

- [Workspaces](../workspaces/): several repos in one session, or one package with `--scope`
- [Memory & instructions](../memory/): what the agent knows about the project
- [Context](../../internals/context/): what's in context and how much room is left
