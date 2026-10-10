---
title: Large codebases
description: Getting an agent the right context in a codebase too big to read. Context packs, maps of the code and its owners, org-scale search, and checkouts of only what you need.
---

In a codebase of millions of lines, the hard part isn't writing the change: it's finding the twenty files that matter. These features get the agent to them without reading everything.

:::note
`/owners`, `/index`, `/map`, `/pack` are specialist commands: they work as always, and show in the `/` list once you start typing their name ([Specialist commands](../../reference/commands/#specialist-commands)).
:::

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

## Who owns what

`/owners` shows who owns the files you changed (or `/owners <path>`, one file or folder), grouped by owner:

```text title="rein"
> /owners
  ⎿ Owners of your 3 changed files:
    @acme/payments  (CODEOWNERS)
      services/payments/charge.ts
      services/payments/refund.ts
    team-search  (Backstage)
      catalog/search/index.ts
```

Rein looks in order:

1. **CODEOWNERS** in `.github/`, the repo root, `docs/` or `.gitlab/`: the last rule that matches wins, as on GitHub. GitLab section headers are skipped.
2. **Backstage**: the `spec.owner` of the `catalog-info.yaml` in the closest folder above the file.
3. **Git history**: the three people with the most commits to the file in the last year.

## Search by meaning

`search` finds exact text. When you don't know the name, ask in words: "where do we retry failed charges?". `/index` builds a **semantic index** of the project: its source and docs files in chunks of about 60 lines, embedded by a model on your own machine through [Ollama](https://ollama.com). Nothing is sent anywhere else.

```text title="rein"
> /index
  ⎿ Indexing with nomic-embed-text through Ollama…
    embedded 1,840 of 1,840 chunks
    Semantic index: 612 files, 1,840 chunks (612 files embedded, 0 removed).

> /index retry a failed payment
  ⎿ services/payments/charge.ts:41-100  (0.71)
      export async function chargeWithRetry(order: Order) {
    …
```

Set it up once:

1. Install Ollama, then `ollama pull nomic-embed-text`.
2. `/settings semanticIndex {}` (or `{"model": "mxbai-embed-large"}`). An Ollama on another machine (`"url": "http://gpu-box:11434"`) also needs `"remote": true`, since what's embedded is your code.
3. `/index`. Run it again after big changes: it's incremental. A file is embedded again only when its git blob changes (or its content, if it's changed but not committed), and deleted files are dropped. Files git ignores are never read.

With the setting on and an index built, the agent gets a [`semantic_search`](../../reference/tools/#semantic_search) tool. `/index <query>` searches it yourself, and `/index status` shows its size, model and age. Indexes live in `~/.rein/index/`, one per project. Changing the model means running `/index` again.

Without Ollama, `/index` says how to install it and does nothing else.

## Search the whole org

The code you need is often in a repo you haven't cloned: who else calls this endpoint, how other teams use the library you're changing. If your company runs [Sourcegraph](https://sourcegraph.com) or [Zoekt](https://github.com/sourcegraph/zoekt), point Rein at it:

```json title="~/.rein/config.json"
{"codeSearch": {"type": "sourcegraph", "url": "https://sourcegraph.example.com"}}
```

or `/settings codeSearch {"type":"zoekt","url":"http://zoekt.internal:6070"}`. The agent then gets an [`org_search`](../../reference/tools/#org_search) tool that searches every repo the server indexes, in that server's query syntax (`repo:^acme/ lang:go RetryPolicy`), and gets back the repo, file, line and matching text.

For Sourcegraph, put an access token in `SRC_ACCESS_TOKEN` (the same variable the `src` CLI uses); Rein reads it from the environment and never saves it. Zoekt's webserver needs none. Without `codeSearch` the tool isn't offered at all.

:::note
Code from other repos is outside content: with `injectionScan` on, `org_search` results are checked for planted instructions like web results are. See [Safety](../safety/).
:::

## Related

- [Workspaces](../workspaces/): several repos in one session, or one package with `--scope`
- [Memory & instructions](../memory/): what the agent knows about the project
- [Context](../../internals/context/): what's in context and how much room is left
