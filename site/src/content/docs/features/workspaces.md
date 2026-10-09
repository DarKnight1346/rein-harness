---
title: Workspaces
description: Work on several repos as one system. A rein.workspace.yaml lists them; every repo becomes a working directory, the agent knows what each one does, and one AGENTS.md applies to all of them.
sidebar:
  badge: New
---

A **workspace** is a set of repos you change together: an API and the apps that call it, a shared library and its users, the services behind one product. Put a `rein.workspace.yaml` in a folder above them and start `rein` in any of the repos (or in the workspace folder itself):

```text
~/code/shop/
├── rein.workspace.yaml
├── AGENTS.md          ← applies to every repo below
├── api/
├── web/               ← run `rein` here
└── billing/           (not cloned yet)
```

```yaml title="rein.workspace.yaml"
name: shop
repos:
  - name: api
    path: api
    role: orders API (provider)
    branch: main
  - path: web
    role: storefront, calls the orders API
  - name: billing
    url: git@github.com:acme/billing.git
```

What that gives you:

- **Every cloned repo is a working directory.** The agent reads, searches and edits them without asking, like the project itself (and like [`/add-dir`](../../reference/commands/), but kept in the manifest instead of retyped each session). This works in [`rein -p`](../headless/) too.
- **The agent knows the system.** The system prompt lists each repo with its path, role and default branch, marks the one you launched in, and tells the agent to make a cross-repo change in every repo it affects.
- **One set of instructions for all of them.** The `AGENTS.md` / `CLAUDE.md` next to the manifest is loaded above each repo's own (see [Memory & instructions](../memory/)). Each repo's own files still come along, scoped to that repo, the first time the agent works in it.

## The manifest

Rein uses the nearest `rein.workspace.yaml` (or `rein.workspace.yml`) at or above the folder you start in.

| Key | Meaning |
|---|---|
| `name` | Optional name, shown by `/workspace` and in the system prompt. |
| `repos` | A list of repos (or a map from name to settings). A plain string is a path. |
| `repos[].path` | The repo's folder, relative to the manifest (`~/` works). Defaults to `name`. |
| `repos[].name` | Defaults to the folder name. Must be unique. |
| `repos[].role` | What the repo does in the system, in your own words. The agent sees it. |
| `repos[].branch` | The repo's default branch. Shown to the agent, and used by `/workspace clone`. |
| `repos[].url` | Git URL, so `/workspace clone` can fetch the repo when its folder is missing. |

Entries Rein can't use (no path or name, a name used twice, invalid YAML) are skipped and reported by `/workspace`, and on stderr in `rein -p`.

## `/workspace`

```text title="rein"
> /workspace
  ⎿ Workspace shop: /Users/you/code/shop/rein.workspace.yaml
      ✓ api  /Users/you/code/shop/api  (orders API (provider))
      ✓ web  /Users/you/code/shop/web  (storefront, calls the orders API)
      · billing  /Users/you/code/shop/billing  not cloned: /workspace clone
```

`/workspace clone` clones every repo that has a `url` and no folder yet (with `--branch` when `branch` is set), then updates what the agent sees.

:::note
Rewind's whole-project snapshots still cover only the repo you launched in. Edits in the other repos are restored from Rein's per-file checkpoints (see [Rewind](../rewind/)).
:::

## Related

- [Memory & instructions](../memory/): how instruction files are loaded
- [Permissions](../permissions/): working directories and what still asks
- [Headless & CI](../headless/): `rein -p` in a workspace
