---
title: Build & test
description: Feedback from builds, tests and CI at monorepo scale. What a change affects, the tests that matter, digests of failing logs.
---

Big repos make the build-and-test loop slow and noisy: the whole suite takes an hour, logs run to thousands of lines, and one flaky test sends the agent chasing ghosts. These features make the loop fast and focused.

## What a change affects

In a monorepo with **Nx**, **Turborepo**, **Bazel** or **Pants**, the build system already knows which projects depend on which. Rein asks it:

```text title="rein"
> /affected
  ⎿ 3 changed files. nx: 2 affected projects:
      api
      web
    Test just these: nx run-many -t test -p api,web
```

- `/affected` uses the working tree's changes against `HEAD`, plus untracked files.
- Rein detects the system from `nx.json`, `turbo.json`, `MODULE.bazel` / `WORKSPACE`, or `pants.toml`. Nx and Turborepo run from the project's `node_modules/.bin` when they're installed there.

| System | How Rein asks | Test command it suggests |
|---|---|---|
| Nx | `nx show projects --affected --files=…` | `nx run-many -t test -p <projects>` |
| Turborepo | `turbo ls --affected` (against the base branch, uncommitted changes included) | `turbo run test --affected` |
| Bazel | `bazel query 'rdeps(//..., set(<files>))'` | `bazel test` on the `*_test` targets among them |
| Pants | `pants --changed-since=HEAD --changed-dependents=transitive list` | the same, with `test` |

With the `affected-tool` [experiment](../../reference/configuration/#experiments) on, the agent gets an [`affected`](../../reference/tools/#affected) tool that answers the same question, so it can run the tests that matter instead of the whole suite. The tool only appears in workspaces with one of these build systems.

## Build caches

Rein looks for the build caches a repo is set up with, so the agent's builds use them like yours do:

| System | Detected from |
|---|---|
| Bazel | `--remote_cache`, `--remote_executor` or `--disk_cache` in `.bazelrc`, `user.bazelrc`, `.bazelrc.user` or `~/.bazelrc` |
| Nx | Nx Cloud (`nxCloudId` / `nxCloudAccessToken` in `nx.json`, or `NX_CLOUD_ACCESS_TOKEN`); otherwise the local `.nx/cache` |
| Turborepo | Remote caching (`TURBO_TOKEN`, or a token in `.turbo/config.json`); otherwise the local `.turbo/cache` |
| Gradle | `org.gradle.caching=true` or a `buildCache { … }` block (remote when it has a `remote` cache) |

The [command sandbox](../permissions/#the-command-sandbox) leaves these writable: local caches live in the project or in package caches it already allows, and on macOS it also allows Bazel's output folder (`/private/var/tmp/_bazel_<you>`). Remote caches need the network, which the default sandbox allows and `strict` doesn't.

`/build` shows the build system, its caches, and whether the sandbox lets agent builds use them:

```text title="rein"
> /build
  ⎿ Build system: bazel. /affected shows what your changes affect.
    Caches:
      bazel: remote (grpcs://cache.example.com)
    Agent builds use these: the sandbox (write) leaves build caches writable and the network open.
```

## Watching CI

`/ci` shows the checks on the current branch's pull request, through the [GitHub CLI](https://cli.github.com) (`gh`, signed in):

```text title="rein"
> /ci
  ⎿ 4 checks: 3 passed, 1 failed
      ✓ CI / lint
      ✗ CI / test (ubuntu)
      ✓ CI / test (macos)
      ✓ CI / build
    /ci watch hands failures to the agent.
```

`/ci watch` checks every minute. When the checks have finished and some failed, Rein reads each failed job's log (`gh run view --log-failed`), boils it down to the failing step, first errors and `file:line` locations, and hands that to the agent as a task: find the cause, fix it, commit, and **ask before pushing**. When you push (or approve the agent's push) and CI runs again, the watcher looks at the new run. It stops when CI passes, after 3 fix rounds, or with `/ci stop`.

The same failed run is only handed over once. Logs are read for GitHub Actions checks; other checks show with their link. GitLab isn't supported yet.

## Testing what a request changed

With the `verify-affected` [experiment](../../reference/configuration/#experiments) on, in an Nx, Turborepo, Bazel or Pants workspace, Rein runs the tests for what a request changed once, at the end of its turn, after the [code check](../code-intelligence/):

- it finds the affected projects or targets (above) and runs their test command;
- it runs it through the `shell` tool, so your approval mode, permission rules and the sandbox apply (in `ask` mode you approve it first);
- if the tests fail, the agent gets the result (with a [digest](#digests-of-failing-logs) when the log is long) and is asked to fix them, or to say which failures aren't caused by its change.

It runs once per request, when the request changed files with Rein's file tools. Without a build system Rein can't tell which tests matter, so it does nothing.

## Digests of failing logs

With the `log-digest` experiment on, a failing command with a long output (80 lines or more) starts with what to look at, before the full output:

```text
<log_digest lines="1840">
Failing step: npm test
First errors:
  FAIL  test/auth.test.ts > session > expires after an hour
  AssertionError: expected 'active' to be 'expired'
Locations: test/auth.test.ts:42, src/auth/session.ts:88
Start from these; the full output follows.
</log_digest>
```

It recognizes GitHub Actions and GitLab CI sections and Gradle tasks as steps, the usual error markers (`error`, `FAIL`, `✗`, tracebacks, assertion errors), and locations in the `file:line`, `file(line,col)` and Python `File "x", line N` forms.

## Tests for what you changed

`/coverage` reads the project's newest coverage report and lists the lines your working tree adds (against `HEAD`, plus untracked files) that no test ran:

```text title="rein"
> /coverage
  ⎿ Changed lines no test ran, per coverage/lcov.info (3 min ago):
      src/auth/session.ts: 42-47, 88
      src/auth/refresh.ts: 12-19
    /coverage tests asks the agent to write tests for them.
```

`/coverage tests` sends that list to the agent, to write tests in the project's style that cover those lines and to run them.

It reads `coverage/lcov.info` (or `lcov.info`), Istanbul's `coverage-final.json`, Cobertura `coverage.xml` (Python's coverage.py, Java, .NET), and Go cover profiles (`coverage.out`, `cover.out`). Report paths can be absolute, relative or Go import paths. Rein doesn't run your tests: run them with coverage first, so the report reflects your changes. Only lines the report instruments count (a blank line or a comment is never "uncovered").

## Do the tests catch bugs?

Agent-written tests can pass without testing much. `/mutate` plants small bugs in the files you changed (a `>` turned into `>=`, a `+` into `-`, a condition forced true) and runs the tests against each. A bug the tests don't notice survived, and that's a gap:

```text title="rein"
> /mutate
  ⎿ stryker: 2 mutants survived (the tests still pass with these bugs planted):
      src/price.ts:12 EqualityOperator → total >= limit
      src/price.ts:20 ArithmeticOperator → a - b
```

`/mutate tests` gives the survivors to the agent, to tighten the tests (not the code) until they catch them.

| Language | Tool | What you get |
|---|---|---|
| JavaScript, TypeScript | [Stryker](https://stryker-mutator.io), installed in the project | Each surviving or uncovered mutant, from its JSON report. Test files themselves aren't mutated |
| Python | [mutmut](https://github.com/boxed/mutmut) | mutmut's own summary |
| Go | [go-mutesting](https://github.com/avito-tech/go-mutesting) | go-mutesting's own summary |

The tool runs on your machine as if you'd started it (not in the agent's sandbox), on the files your working tree changed against `HEAD`. Mutation testing is slow: it runs the tests once per mutant.

## Flaky tests

A flaky test sends an agent chasing a bug that isn't there. With the `flaky-quarantine` [experiment](../../reference/configuration/#experiments) on, Rein records the outcome of every test the agent runs (vitest, jest, mocha, pytest, `go test`, `cargo test`/`nextest`, and `npm`/`pnpm`/`yarn`/`bun test`) together with a fingerprint of the code it ran on: `HEAD` plus the uncommitted diff.

- A test that **failed and passed on the same code** is flaky. A test that started passing after a change was fixed, not flaky.
- When a later run fails and every failure is a known flaky test, the agent is told so, and to re-run once and treat the run as passing if only those fail again. When only some failures are flaky, it's told to ignore those and fix the rest.

`/flaky` lists the known flaky tests in this project; `/flaky clear` forgets them. They're kept per project in `~/.rein/state/flaky/`.

## Slower builds

Rein times every successful build or test command the agent runs (`tsc`, `make`, Gradle, Maven, `bazel build`/`test`, `cargo build`, `go build`/`test`, webpack, Vite, Next, Nx, Turborepo, `npm run build`, test runners…) and keeps the last 10 runs of each, per project. When a run takes **1.5× its usual time and at least 30 seconds more** (the usual being the median of the last 5, once there are 3), you see a warning under that tool call:

```text
⏺ Shell(npm test)
  ⎿ 1,204 passed
  ⚠ This took 2.5 min, 2.5× its usual 1.0 min (median of the last 4 runs). Something in this change may have slowed the build or tests.
```

The agent isn't told; it's for you to decide whether to look. It's on by default; turn it off with `/settings buildTimeWarnings false`. Times are kept in `~/.rein/state/build-times/`.

## Related

- [Code intelligence](../code-intelligence/): the end-of-turn code check and Semgrep
- [Headless & CI](../headless/): Rein in your pipeline
- [Workspaces](../workspaces/): `--scope` for one package of a monorepo
