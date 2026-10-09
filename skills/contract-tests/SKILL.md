# Contract tests between services (Pact)

Write **consumer-driven contract tests** for the boundaries the user named, or, if they named none, for every place this service calls another one over HTTP or messages. A consumer test records exactly what this service needs from the other one (requests it makes, the response fields it reads) as a pact; the provider runs those pacts against itself, so a provider change that breaks a consumer fails the provider's build instead of production.

## 1. Find the boundaries

- **Outgoing calls**: HTTP clients (`fetch`, `axios`, `got`, `requests`, `httpx`, `net/http`, `RestTemplate`, `WebClient`, generated OpenAPI or gRPC clients) and their base URLs; message producers and consumers (Kafka, SQS, RabbitMQ, Pub/Sub).
- **Who is on the other side**: the service name, and its repo if it's in this workspace (search and list with `workspace: true`) or findable with `org_search`. Its OpenAPI or protobuf contract, if there is one.
- **What this service actually uses**: the endpoints it calls, the fields it sends, and the response fields its code reads (not the whole response).

List them and, if there are many, ask with `ask_user` which to cover first.

## 2. Pact in this project

Look for an existing Pact setup and follow it:

| Language | Library | Look for |
| --- | --- | --- |
| JS / TS | `@pact-foundation/pact` | `package.json`, existing `*.pact.test.*` / `pact/` folders |
| Python | `pact-python` | `requirements*.txt`, `pyproject.toml` |
| JVM | `au.com.dius.pact` | `build.gradle*`, `pom.xml` |
| Go | `github.com/pact-foundation/pact-go/v2` | `go.mod` |
| .NET | `PactNet` | `*.csproj` |
| Ruby | `pact` | `Gemfile` |

If Pact isn't there, say so and ask before adding it (it's a dev dependency; the install command needs the user's approval anyway). If they decline, stop and summarize the boundaries you found.

Where pacts go: a broker if one is configured (`PACT_BROKER_BASE_URL`, a `pact_broker` / PactFlow config, CI publishing steps), otherwise a `pacts/` folder the provider's verification reads.

## 3. Consumer tests

For each boundary, in this service's test suite:

- One interaction per behaviour the code depends on (the happy path, and the error responses the code handles: 404, 409, validation errors). Give each a `given` provider state in plain words ("order 42 exists").
- **Match loosely**: type matchers (`like`, `eachLike`, regex) for values, exact values only where the code depends on them. Include only the fields the code reads.
- Point this service's real client code at the Pact mock server and call it, so the test fails if the client and the pact disagree.

Run them; they must pass and write the pact files.

## 4. Provider verification

If the provider is in this workspace (or the user wants it): add a verification test there that replays the pacts against the running provider, with **state handlers** that set up each `given` state (test data, stubs of its own dependencies). Run it. If it fails, that is a real incompatibility: report it, don't loosen the pact to make it pass.

If the provider lives elsewhere, write down what it needs to verify (the pact location, the provider states) for its owners.

## 5. Report

The boundaries covered and the interactions per boundary, where the pacts are written or published, how to run consumer and provider tests (and add them to CI if the user agrees), and what's left uncovered.
