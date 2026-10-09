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

## Related

- [Specs](../specs/): requirements and design before the change
- [Pull requests](../pull-requests/): the reviewer's view of the change
