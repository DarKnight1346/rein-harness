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

## Related

- [Code intelligence](../code-intelligence/): the end-of-turn code check and Semgrep
- [Headless & CI](../headless/): Rein in your pipeline
- [Workspaces](../workspaces/): `--scope` for one package of a monorepo
