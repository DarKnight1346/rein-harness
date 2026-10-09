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

## Related

- [Workspaces](../workspaces/): several repos as one system
- [Contracts & migrations](../contracts/): which changes break callers
