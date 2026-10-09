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

## Related

- [Workspaces](../workspaces/): several repos in one session, or one package with `--scope`
- [Memory & instructions](../memory/): what the agent knows about the project
- [Context](../../internals/context/): what's in context and how much room is left
