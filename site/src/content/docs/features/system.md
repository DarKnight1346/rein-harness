---
title: Your whole system
description: Understanding across services and repos. Which service calls which, symbols and references across repos, who is affected by a change, coordinated changes in several repos, architecture maps, and a container sandbox and local stack per task.
---

A change to one service is a change to everything that calls it. These features give the agent, and you, the view across services and repos that a single checkout doesn't have. They work best in a [workspace](../workspaces/), and also in a monorepo with `services/`, `apps/` or `packages/` folders.

## Which service calls which

`/services` draws the dependency graph, with the evidence for every link:

```text title="rein"
> /services
  ⎿ 5 services, 6 dependencies:
      orders  (provides http openapi.yaml)
        → ledger  [compose] docker-compose.yml: orders depends on ledger
        → ledger  [grpc] services/orders/src/ledger.ts:2 (Ledger client)
        → money  [package] services/orders/package.json: depends on @shop/money
      web
        → orders  [http] services/web/src/api.ts:1 (ORDERS_URL)
        → search  [kubernetes] services/web/k8s/deploy.yaml
      …
```

**Services** are the repos of a workspace. In a single repo, they're the folders under `services/`, `apps/`, `packages/`, `cmd/`, `svc/` or `microservices/` that have their own manifest or Dockerfile. **Links** come from:

| Source | What counts |
| --- | --- |
| docker-compose | `depends_on` and `links` between services, and URLs in their environment |
| Kubernetes and Helm | URLs and `name.namespace.svc` hosts in manifests and values files |
| Code, `.env` and config | URLs naming another service (`http://orders:8080`, `grpc://ledger`), and settings named after one (`ORDERS_URL`, `LEDGER_ADDR`, `SEARCH_HOST`) |
| gRPC | A `LedgerClient` / `LedgerStub` where another service's `.proto` defines `service Ledger` |
| Packages | A `package.json` dependency on another service's package, or a `go.mod` require of its module |

Each service's contracts (OpenAPI, protobuf services, GraphQL) are listed as what it **provides**. `/services mermaid` prints the graph as a Mermaid diagram for docs and PRs. With the `system-graph` [experiment](../../reference/configuration/#experiments) on, the agent gets a [`service_graph`](../../reference/tools/#service_graph) tool to ask who calls a service before changing its API.

## Symbols across repos

A language server knows one repo. When `@shop/money` defines `format` and three other repos call it, finding those calls means joining the repos' indexes. Rein reads [SCIP](https://github.com/sourcegraph/scip) indexes, the format code-intelligence indexers write, from each repo (`index.scip` or `.rein/index.scip`), and joins them:

```text title="rein"
> /symbols
  ⎿ 2 symbols used outside the repo that defines them (indexes from money, web, orders):
      format  money → web, orders
      Currency  money → orders

> /symbols format
  ⎿ format  scip-typescript npm @shop/money src/`format.ts`/format().
      defined  money  src/format.ts:5
      used     web  src/cart.tsx:12
      used     orders  src/invoice.ts:40
```

A symbol in one repo matches one in another when the package and the path to it are the same. The version is left out, since repos pin different versions of a shared library. Local symbols (inside one function) aren't joined.

`/symbols index` writes each repo's `index.scip` with the indexer for its language, when it's installed: `scip-typescript`, `scip-python`, `scip-go`, `scip-java` or `rust-analyzer scip`. Indexers that aren't installed are skipped and listed. You can also produce the indexes in CI and check them out with the code. With the `system-graph` [experiment](../../reference/configuration/#experiments) on, the agent gets a [`symbol_refs`](../../reference/tools/#symbol_refs) tool for the same lookups.

Within one repo, the agent's usual code intelligence (language servers) still answers go-to-definition and references. SCIP is what connects the repos.

## Follow a call across repos

An endpoint is a string, not a symbol: no language server connects `fetch(\`${base}/orders/${id}\`)` in the web app to `router.get('/orders/:id', …)` in the orders service. `/refs` does:

```text title="rein"
> /refs GET /orders/{id}
  ⎿ GET /orders/{id}
    Gateway:
      gateway  services/gateway/ingress.yaml:6  - path: /orders
    Served by:
      orders  services/orders/openapi.yaml:3  /orders/{id}:
      orders  services/orders/src/routes.ts:1  router.get('/orders/:id', getOrder);
    Called from:
      web  services/web/src/api.ts:1  export const order = (id) => fetch(`${base}/orders/${id}`);
      mobile-bff  services/mobile-bff/app.py:1  resp = requests.get(f"{ORDERS}/orders/{order_id}")
```

**Endpoints** are matched whatever the parameter syntax: `{id}`, `:id`, `${id}`, `<id>`, `%s`, `'/orders/' + id`. Each match is sorted into one of three places:

- **Gateway:** Kubernetes Ingress paths, and nginx, Kong, Envoy and Traefik config.
- **Served by:** OpenAPI paths, and route registrations. That covers Express, Koa and Fastify routers, FastAPI and Flask decorators, Spring `@GetMapping`…, and Go's `HandleFunc`, gin, echo and chi.
- **Called from:** call sites in code.

When the method shows on the line (`axios.post`, `requests.get`, `method: 'POST'`, a one-argument `fetch` is a GET), calls with another method are left out. When it doesn't, the call is kept. Docs and tests aren't counted as callers.

**gRPC methods** (`/refs Ledger.Post`) go from the `rpc` in the `.proto`, to its implementation in the service that owns it, to the calls in files that use a `LedgerClient` or `LedgerStub`.

For a function or type, use [`/symbols <name>`](#symbols-across-repos). With the `system-graph` experiment on, the agent gets [`api_refs`](../../reference/tools/#api_refs) for the same search.

## Who a change affects

Before you open the PR: who else breaks? `/impact` puts the pieces above together for the branch you're on:

```text title="rein"
> /impact
  ⎿ Impact of this branch (against origin/main): 2 changed things, 3 callers

    ✗ breaking GET /orders/{id}  (1 caller in 1 service)
        ✗ GET /orders/{id} 200.total: response field removed
        web:
          services/web/order.ts:2  const o = await fetch(`/orders/${id}`);

    · formatMoney  (2 callers in 1 service)
        changed in packages/money/format.ts
        web:
          services/web/order.ts:1  import {formatMoney} from '@shop/money';
          services/web/order.ts:3  show(formatMoney(o.total));
```

It works in three steps:

1. **What changed.** For endpoints and RPCs, it uses the [contract changes](../contracts/#breaking-or-safe) the branch makes (OpenAPI, protobuf), marked breaking or safe. For exported functions, classes and types (JS/TS, Python, Go), it uses the definitions the diff touches. In a workspace, each repo's own branch counts.
2. **Who calls it.** Endpoints and RPCs are followed like [`/refs`](#follow-a-call-across-repos). Symbols go through the repos' [SCIP indexes](#symbols-across-repos) when there are any, and otherwise a whole-word search in the other services.
3. **The report.** Breaking changes come first, then the most-used.

## One change, several repos

Some tasks are one change in three places: the API, the client library and the app that uses it. A **change set** keeps them together:

```text title="rein"
> /changeset start split-users api web
  ⎿ Change set split-users: branch split-users in api, web.

> … the agent makes the change in both repos …

> /changeset test
  ⎿ api: npm test…
    web: npm test…
    All 2 repos pass, tested in dependency order:
      ✓ api  npm test
      ✓ web  npm test

> /changeset pr yes
  ⎿ Opened pull requests in api, web.
    Linked api#41, web#118.
```

| Command | What it does |
| --- | --- |
| `/changeset start <name> [repo…]` | Creates (or switches to) the branch `<name>` in each repo you name, or every cloned repo of the [workspace](../workspaces/). Uncommitted changes come along. Saved in the workspace's `.rein/changesets/<name>.json` |
| `/changeset status [name]` | Each repo: on the branch or not, commits ahead of its default branch, uncommitted files |
| `/changeset test [name]` | Each repo's test command on its branch, in **dependency order**: repos that others call (by [`/services`](#which-service-calls-which)) before the ones that call them. A repo that's on another branch counts as failed, and one with no test command is skipped |
| `/changeset pr [name]` | Says what it would do. `/changeset pr yes` pushes the branch in each repo, opens a pull request with `gh`, and [links them to each other](../workspaces/#pull-requests-across-repos) |

Without a name, these work on the newest change set. Testing in dependency order means a failing API shows up before the app that depends on it. Wiring local versions of one repo into another (npm workspaces, `go work`, `replace` directives) is up to your project's setup.

## Codemaps

`/codemap` writes an architecture map you can browse on GitHub and commit with the code, in `docs/codemap/`:

- **`README.md`**: the service graph as a Mermaid diagram, and a table of every service with what it provides, calls and is called by.
- **A page per service**, with these sections:
  - **Notes.**
  - **Provides:** its API contracts.
  - **Calls** and **Called by**, with the evidence and links to those pages.
  - **Entry points.**
  - **Layout:** its main folders and how many files each has.
  - **Key declarations**, from the [repo map](../large-codebases/#a-map-of-the-repo).

  Its owners from CODEOWNERS or Backstage go at the top.

```text title="rein"
> /codemap
  ⎿ Codemap: wrote ledger, money, orders, search, web, in docs/codemap/.

> /codemap status
  ⎿ Codemap in docs/codemap:
      out of date: orders (/codemap refreshes them)
      no notes yet: ledger, money, search, web (/codemap annotate)
```

**Kept fresh:** each page records what its service looked like when it was written, so `/codemap` rewrites only the services whose files or links changed, and `/codemap status` lists the stale ones. Run it before a release, or add it to a [scheduled job](../headless/#scheduled-jobs). `/codemap rebuild` rewrites every page.

**Annotated:** the **Notes** section is yours. It sits between `<!-- rein:notes -->` markers and regeneration never touches it. `/codemap annotate` has the agent read each service without notes and write a few sentences: what it's for, how a request moves through it, what it depends on and why, and what surprises newcomers. Everything else on the page is generated.

## A container per task

The OS sandbox limits where commands write. For unattended work on code you don't fully trust, you can go further: with `sandbox: "container"` (`/settings` → General → Sandbox → Container), each conversation's commands run in a **container of their own**, with Docker or Podman.

```json title="~/.rein/config.json"
{
  "sandbox": "container",
  "containerSandbox": {
    "image": "node:22-bookworm",
    "egress": ["registry.npmjs.org", "*.github.com"]
  }
}
```

**The container:** it starts with the first command, from `image` (default `node:22-bookworm`; use one with your project's toolchain). The project and the [workspace](../workspaces/) repos are mounted at their own paths, so file paths are the same inside and out. Each command runs with `docker exec` (or `podman exec`) from the folder it was given. Nothing else on your machine is visible: not your home folder, your SSH keys or your environment variables.

**The network:**

- **No `egress`:** the container has no network at all (`--network none`).
- **With `egress`:** it sits on an internal network with no way out except a small proxy container, which lets through only the listed hosts (exact names, or `*.example.com`). Everything else gets *403, not on this task's egress allowlist*. The proxy works through `HTTP_PROXY` and `HTTPS_PROXY`, which package managers and most tools use.

**Lifetime:** the containers and their network are removed when Rein exits. `runtime` picks `docker` or `podman`; by default it's whichever is running. With neither running, Rein says so once, and commands fall back to the normal OS sandbox (**On**).

:::note
Rein's own tools (`read`, `edit`, `search`…) work on your machine as usual. The container holds the agent's shell commands: builds, tests, package installs, scripts.
:::

## The services a change needs

Tests against mocks pass while the real service disagrees. `/stack up` brings up the real neighbours, with [Docker Compose](https://docs.docker.com/compose/):

```text title="rein"
> /stack up
  ⎿ Starting web (docker compose up --wait)…
    Up and healthy: web, orders, db.
      ✓ web  running (healthy)  localhost:3000 → 3000/tcp
      ✓ orders  running (healthy)  localhost:8080 → 8080/tcp
      ✓ db  running
```

- **Which services.** With no names, Rein starts the compose services built from the folders your branch changes (by `build` context, or a service named like the folder), and Compose adds their `depends_on`. Name them to choose: `/stack up orders web`.
- **Healthy, not just started.** Rein waits for each service's health check (`docker compose up --wait`, polling on older Compose) and lists the ports it publishes. A service that isn't healthy in five minutes is reported with its state.
- **The rest:** `/stack status` shows what's running, `/stack logs <service>` its recent output, and `/stack down` stops it all. The stack keeps running until you stop it.
- **Helm:** `/stack up --helm <chart folder>` installs a chart with `helm upgrade --install … --wait`. It only goes into a **local** cluster (a kubectl context of kind, k3d, minikube, Docker Desktop, Rancher Desktop, OrbStack or Colima); any other context is refused.

The compose file is the workspace's (or the project's) `compose.yaml` or `docker-compose.yml`. With the `stack-tool` [experiment](../../reference/configuration/#experiments) on, the agent gets a [`stack`](../../reference/tools/#stack) tool. It can bring up what its change needs, test against it, read a service's logs when something fails, and stop it again. Like any command, that goes through approvals.

## Related

- [Workspaces](../workspaces/): several repos as one system
- [Contracts & migrations](../contracts/): which changes break callers
