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

## Related

- [Workspaces](../workspaces/): several repos as one system
- [Contracts & migrations](../contracts/): which changes break callers
