---
title: Contracts & migrations
description: Changes that other code depends on. Which API contract changes break clients, how to make them in safe steps, contract tests between services, migration safety, codemods for repetitive changes, migration playbooks, and dead code and stale flags.
---

Some changes reach further than the code you're editing: the clients of an API, the services that read a message, the data already in a table. This page covers the tools that make those changes safely.

## Breaking or safe

`/contracts` compares every API contract the branch changes with the branch's base, and marks each change **breaking** or **safe**:

```text title="rein"
> /contracts
  ⎿ Contract changes against origin/main: 2 files with breaking changes
    api/openapi.yaml: 2 breaking, 2 safe
      ✗ DELETE /orders/{id}: operation removed
      ✗ POST /orders body.qty: new required request field
      ✓ GET /orders/{id} 200.currency: response field added
      ✓ GET /orders/{id} query fields: optional parameter added
    proto/order.proto: 1 breaking
      ✗ Order.note (= 3): field removed without reserving its number: a later field could reuse it
```

A change is breaking when a client written against the old contract can fail with the new one. Rein reads the formats itself, with no external tools:

| Format | Files | Breaking | Safe |
| --- | --- | --- | --- |
| **OpenAPI 3 / Swagger 2** | `openapi*.yaml`, `swagger*.json`, or any YAML/JSON with an `openapi:` / `swagger:` key | operation removed; parameter or request field newly required; required parameter removed; response field removed or no longer always present; type changed; request enum value removed; new response enum value | additions: operations, optional parameters and fields, responses, request enum values |
| **protobuf** | `.proto` | message, enum, rpc removed; field removed without `reserved`; type, name, number or `repeated` changed; rpc signature changed; enum value removed or renumbered; package renamed | fields, messages, rpcs and enum values added; a field removed with its number reserved |
| **GraphQL SDL** | `.graphql`, `.gql` | type or field removed; type changed; output field became nullable; input field or argument became required; new required argument without a default | types, fields, optional arguments and enum values added |
| **Avro** | `.avsc` | new field without a default; type changed other than a promotion (`int`→`long`…); enum symbols removed without a default | fields added with a default; fields removed; enum symbols added |

`$ref`s inside OpenAPI documents are followed. Avro is checked as backward compatibility: data written with the old schema must still read with the new one. A contract file that was deleted is breaking, and a new one is safe.

With the `contract-check` [experiment](../../reference/configuration/#experiments) on, the agent hears about it at the end of a request that broke a contract it changed. It's told to say so if the break is intended (and make it a versioned or [expand/contract](#expand-and-contract) change), or else to make the change backward compatible.

## Migration safety

A migration that's fine on your laptop can take production down. A table rewrite holds a lock for minutes, a `NOT NULL` column fails on the first existing row, and a rename breaks the old version of the app while the deploy is still rolling. `/migrations` reads the migration files this branch adds or changes and flags those steps, each with the safer way:

```text title="rein"
> /migrations
  ⎿ 3 risks in 1 migration file (against origin/main):
      db/migrations/0042_totals.sql:2  [needs a backfill] adds a NOT NULL column without a default: fails on a table that has rows
          instead: add it nullable (or with a default), backfill in batches, then SET NOT NULL
      db/migrations/0042_totals.sql:4  [locks] creates an index without CONCURRENTLY: writes to the table block until it is built
          instead: CREATE INDEX CONCURRENTLY (outside a transaction); in MySQL, ALGORITHM=INPLACE, LOCK=NONE
      db/migrations/0042_totals.sql:9  [breaks running code] renames a column or table: code still running from the previous deploy breaks at once
          instead: add the new name, dual-write, move readers, then drop the old one (expand/contract), or use a view
```

| Risk | What's flagged |
| --- | --- |
| **Locks** | Indexes built without `CONCURRENTLY` (Rails `algorithm: :concurrently`, Django `AddIndexConcurrently`, Alembic `postgresql_concurrently=True`); column type changes; `SET NOT NULL`; foreign keys and checks without `NOT VALID`; volatile column defaults (`now()`, `gen_random_uuid()`…); `LOCK TABLE`, `VACUUM FULL`, `CLUSTER` |
| **Needs a backfill** | A `NOT NULL` column (Rails `null: false`, Django without `null=True` or a default, Alembic `nullable=False` without `server_default`) with no default; `UPDATE` or `DELETE` of every row inside the migration |
| **Irreversible** | `DROP COLUMN`, `DROP TABLE`, `TRUNCATE`, `remove_column`, `RemoveField`, `drop_column`; an `.up.sql` without its `.down.sql`, an empty goose/sql-migrate `Down`, `up()` without `down()`, an empty Alembic `downgrade()` |
| **Breaks running code** | Renames of columns and tables (`RENAME`, `rename_column`, `RenameField`, `new_column_name=`) |

Rein knows migrations by where they live: `migrations/`, `db/migrate/`, `alembic/versions/`, Flyway's `V1__name.sql`, `*.up.sql`. It reads plain SQL (Postgres first, with MySQL's online-DDL options), Rails, Django and Alembic migrations, plus the SQL inside `RunSQL`, `op.execute` and Knex or TypeORM `raw`/`query` calls. Down migrations aren't flagged for undoing things. Some findings depend on table size and database version; the agent and you decide which apply.

With the `migration-check` [experiment](../../reference/configuration/#experiments) on, the agent hears about these at the end of a request that wrote migrations. It fixes the ones that apply, and says so when a step is deliberate.

## Expand and contract

Renaming a column, changing a field's type or removing an endpoint breaks whatever still uses the old shape. That includes the old version of your own service, which keeps running during a deploy. The safe way is three phases, each deployed on its own:

1. **Expand**: add the new shape next to the old one, and write both.
2. **Migrate**: backfill the data, then move readers and clients over, checking as you go.
3. **Contract**: once nothing uses the old shape, remove it.

`/expand-contract <change>` plans that for you, in [plan mode](../plans/):

```text title="rein"
> /expand-contract rename orders.total to orders.total_cents, used by the API and the billing worker
```

The agent:

- **Finds who depends on the old shape.** That's readers and writers in this repo, in every [workspace](../workspaces/) repo, and across the org with [`org_search`](../large-codebases/#search-the-whole-org). It also counts stored data and clients you can't redeploy.
- **Asks what it can't find**, such as deploy order and how long old clients live.
- **Picks the pattern for the change**: rename, change a type, make something required, split a table or service, remove or rename an API field, or evolve an event schema.
- **Presents a plan with one milestone per step.** Each step says why it's safe to deploy alone, how the data moves (batched, resumable backfills, kept out of the schema migration), how to verify it before moving on, and how to roll it back.

Steps that have to wait, for old clients or for a backfill to finish, are separate deploys.

## Contract tests between services

`/contracts` tells you a schema change is breaking. A **contract test** tells you before the change ships, from the consumer's side: each consumer records what it needs from a provider (the requests it makes, the response fields it reads) as a *pact*, and the provider's build replays every pact against itself.

`/contract-tests` writes them with [Pact](https://pact.io):

```text title="rein"
> /contract-tests the calls to the orders service
```

1. **Boundaries.** The agent finds this service's outgoing calls: HTTP clients and their base URLs, generated OpenAPI or gRPC clients, and message producers and consumers. It finds the service on the other side, in the [workspace](../workspaces/) or with `org_search`, and which endpoints and fields the code really uses.
2. **Pact.** It follows an existing setup for JS/TS, Python, JVM, Go, .NET or Ruby. If there's none, it asks before adding the library, and stops if you say no. Pacts go to your broker when one is configured (`PACT_BROKER_BASE_URL`), else to a `pacts/` folder.
3. **Consumer tests.** It writes one interaction per behaviour the code depends on, including the errors it handles. Each has a provider state ("order 42 exists"), uses loose matchers, and includes only the fields the code reads. The service's real client calls the Pact mock server.
4. **Provider verification.** When the provider is in your workspace, it adds a verification test there with state handlers and runs it. A failure is reported as a real incompatibility, never loosened away.

## Codemods for repetitive changes

Renaming a function used in 300 files, moving every call site to a new API, swapping a library: an agent editing those one by one is slow, uneven, and leaves a diff nobody wants to review. A **codemod** is a script that makes the change everywhere the same way.

`/codemod <change>` has the agent write one:

1. **The change.** It finds every place it applies, across the [workspace](../workspaces/) or the org if needed, notes the variations (aliased imports, odd argument shapes, generated files), and writes the rule with real before/after examples. For under about five simple places it just edits them.
2. **The tool.** It picks what fits the language and what the project already uses:
   - **jscodeshift** or **ts-morph** for JS/TS.
   - **OpenRewrite** for Java and Kotlin.
   - **LibCST** for Python.
   - `gofmt -r` or `go/ast` for Go.
   - **Comby** for any language.
   - `sed` only when the pattern can't be ambiguous.

   Installing a tool goes through the usual approval.
3. **Small, then everywhere.** It writes the script to be idempotent and to skip (and list) what it can't handle cleanly. It tries it on two or three files and reads the diff, then runs it on all of them. Last come the formatter, the build or type checker, and the tests.
4. **Report.** It tells you the files changed, the rule, the command to run the codemod again on branches that land later, and what was skipped.

With the `codemod-nudge` [experiment](../../reference/configuration/#experiments) on, Rein notices when the agent makes the **same hand edit in four files** within a request. It tells the agent to write a codemod for the rest. That happens once per change.

## Related

- [Specs](../specs/): requirements and design before the change
- [Pull requests](../pull-requests/): the reviewer's view of the change
