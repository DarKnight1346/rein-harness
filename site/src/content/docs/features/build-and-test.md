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

## Flaky tests

A flaky test sends an agent chasing a bug that isn't there. With the `flaky-quarantine` [experiment](../../reference/configuration/#experiments) on, Rein records the outcome of every test the agent runs (vitest, jest, mocha, pytest, `go test`, `cargo test`/`nextest`, and `npm`/`pnpm`/`yarn`/`bun test`) together with a fingerprint of the code it ran on: `HEAD` plus the uncommitted diff.

- A test that **failed and passed on the same code** is flaky. A test that started passing after a change was fixed, not flaky.
- When a later run fails and every failure is a known flaky test, the agent is told so, and to re-run once and treat the run as passing if only those fail again. When only some failures are flaky, it's told to ignore those and fix the rest.

`/flaky` lists the known flaky tests in this project; `/flaky clear` forgets them. They're kept per project in `~/.rein/state/flaky/`.

## Related

- [Code intelligence](../code-intelligence/): the end-of-turn code check and Semgrep
- [Headless & CI](../headless/): Rein in your pipeline
- [Workspaces](../workspaces/): `--scope` for one package of a monorepo
