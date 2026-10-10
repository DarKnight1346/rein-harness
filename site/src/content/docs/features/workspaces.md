---
title: Workspaces
description: Work on several repos as one system, or on one package of a monorepo. A rein.workspace.yaml lists the repos; --scope focuses the agent on one package.
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
| `repos[].sparse` | Folders to check out (git's cone mode); the rest stays in git, not on disk. See [Huge repos](#huge-repos-sparse-and-partial-clones). |
| `repos[].filter` | Partial clone: `blob:none` fetches file contents only when needed, `tree:0` folders too. |

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
`/rewind` covers every repo: each one is snapshotted before every message, and a code rewind restores them all to the same point (see [Rewind](../rewind/#every-repo-of-a-workspace)).
:::

## Huge repos: sparse and partial clones

A monorepo with millions of files doesn't need to be on disk whole for you to work on one corner of it. Say which folders you need:

```yaml title="rein.workspace.yaml"
repos:
  - name: mono
    url: git@github.com:acme/mono.git
    sparse: [services/payments, libs/money]
    filter: blob:none
```

`/workspace clone` then runs `git clone --filter=blob:none --sparse` and `git sparse-checkout set --cone services/payments libs/money`. Only those folders and the top-level files are checked out, and with `filter` git downloads file contents only when something reads them.

```text title="rein"
> /workspace sparse
  ⎿ Checkouts:
      mono  sparse: services/payments, libs/money · partial clone (blob:none)
      web  full checkout

> /workspace sparse mono services/ledger
  ⎿ Checked out services/ledger in mono.
```

The agent is told what's missing. When you launch Rein in a sparse checkout (in a workspace or not), the system prompt says which folders are on disk. It also says the rest is in git: `git ls-tree -r --name-only HEAD <folder>` lists it, and `git show HEAD:<path>` reads a file without checking it out. To change files outside the checkout, the agent asks you to widen it.

Repos you cloned sparse yourself (`git clone --sparse`) work the same way. Rein reads git's own settings, so `sparse` in the manifest only matters for `/workspace clone`.

## One tree for every repo

The repos stay separate on disk, but the agent can treat them as one tree. `search` and `list` with `workspace: true` run over every cloned repo in one call (a `path` is taken inside each), and group what they find by repo:

```text
## web (.)
src/cart.ts:12:  await fetch("/orders")

## api (../api)
../api/src/orders.ts:40:router.post("/orders", createOrder)
```

Paths are relative to the repo you launched in, so `read` and `edit` take them as they are. The system prompt tells the agent this option exists when you're in a workspace.

## Workspace memory

Some things are true of the system, not of one repo: "api releases before web", "every service reads its config from Vault". The agent saves those with `remember` and `scope: "workspace"`, in the workspace's own `.rein/MEMORY.md` (next to `rein.workspace.yaml`). Every repo of the workspace sees them, in a **Workspace memory** section of the system prompt next to its own project memory. `forget` removes matching facts from both. Like project memory, it's a plain file you can edit or commit.

## Pull requests across repos

A change that spans repos ends up as one pull request per repo, and reviewers need to know they belong together. With the same branch name in each repo:

- `/workspace prs` lists the pull request for the current branch in every cloned repo of the workspace (through `gh`).
- `/workspace link-prs` shows what it would do; `/workspace link-prs yes` adds a **Related pull requests** section to each description, listing the others and saying to merge them together. The section sits between `<!-- rein:linked-prs -->` markers, so running it again updates it instead of adding another.

## One package of a monorepo

The opposite problem: one huge repo where you only work on one package. `rein --scope packages/api` (or `/scope packages/api` in a session) focuses the agent there:

- `list` and `search` without a path, and `shell` without a `cwd`, start in the package instead of the repo root.
- Instruction files load as if you had launched in the package: every `AGENTS.md` / `CLAUDE.md` from the git root down to it.
- The system prompt names the scope and asks the agent to stay inside it, going outside only when the task needs it (a shared type, a caller it broke), and to say so.
- The end-of-turn [code check](../code-intelligence/) skips callers outside the package that the agent didn't edit. Files it did edit are still checked wherever they are.

It's a focus, not a fence: the agent can still read or edit outside the package with an explicit path. `/scope off` goes back to the whole repo. The scope must be a folder inside the project.

## Related

- [Memory & instructions](../memory/): how instruction files are loaded
- [Permissions](../permissions/): working directories and what still asks
- [Headless & CI](../headless/): `rein -p` in a workspace
