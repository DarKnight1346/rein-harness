# Open-source roadmap

The 81 free features from the Rein feature roadmap, in build order. Numbers (`#29`) are the roadmap's feature
numbers. Waves are ordered so each one builds on the last: workspace and cost foundations first, because most later
features read the workspace (which repos) or the price of a run. Update the Docs (a path under the docs site) and Status columns as features land; the site's What's new page is built from this file.

Every feature follows `AGENTS.md`: official `claude` / `codex` binaries only, no OAuth tokens, tests with the fake
CLIs, docs in `site/` in the same change, `node site/scripts/check-docs.mjs` passing. Anything that changes how the
agent works by default ships as an experiment (`experiments` in config) until it's measured.

## Wave 1: Workspace and cost foundations

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 1 | Extra repos in `rein -p` | Honour `--add-dir` in headless runs (today only `additionalDirectories` applies there). | features/headless/ | done |
| 2 | Workspace-level AGENTS.md | An instruction file above several repos, layered over each repo's own AGENTS.md / CLAUDE.md. | features/workspaces/ | done |
| 29 | Workspace manifest | `rein.workspace.yaml`: repos (path or git URL), role, default branch; one session opens them all, writable. Feeds every later multi-repo feature. | features/workspaces/ | done |
| 3 | Monorepo scope flag | `--scope <dir>` (and `/scope`) limits search, list, instructions and code checks to one package. | features/workspaces/#one-package-of-a-monorepo | done |
| 4 | Dollar cost per turn, session and goal | Price the token totals Rein already counts (built-in price table, overridable in config); show in the sidebar, `/cost`, `rein -p` JSON. | features/cost/ | done |
| 7 | Context budget view | Extend `/context`: what is in context and why (instructions, files read, tool results, summary), with sizes. | internals/context/#context | done |
| 72 | OpenTelemetry export | Sessions, turns, tool calls and token/cost metrics as OTel traces and metrics (OTLP endpoint in config, off by default). | features/observability/ | done |

## Wave 2: Spend control and safety

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 5 | Cost estimate before running | `/goal` shows what goals in this project have cost (median and range of finished ones); asks above `goalConfirmUsd`. | features/cost/#goal-estimates | done |
| 6 | Budgets with a hard stop | Per-task, per-goal and per-repo caps (tokens or dollars) that pause the agent and say why. | features/cost/#budgets | done |
| 8 | Context-bloat warnings | Flag oversized tool results and stale reads; suggest what to compact or drop. | internals/context/#context-warnings | done |
| 10 | Stuck-loop watchdog | Detect repeated edits or the same failing command with no progress; stop or escalate. | reference/configuration/#experiments | done |
| 18 | Secret scanning on every diff | Block secrets in agent edits and redact them from saved transcripts. | features/permissions/#secret-scanning | done |
| 19 | SAST on changed code | Run Semgrep (when installed) on files a request changed; findings on added lines go back like the code check. CodeQL isn't run: it needs a full database build per run. | features/code-intelligence/#static-analysis-with-semgrep | done |
| 67 | Prompt-injection scanner | Screen issue text, PR text, fetched pages and MCP results for injected instructions; warn the agent and the user. | features/safety/#planted-instructions-injectionscan | done |
| 68 | Exfiltration guard | When private data and untrusted input are both in context, network-capable tools need approval. | features/safety/#data-leaving-the-machine-exfilguard | done |
| 69 | Pinned MCP servers | Allowlist MCP servers by version and hash; warn and ask when one changes. | features/safety/#changed-mcp-servers-mcppinning | done |
| 70 | Dependency supply-chain check | Vet newly added packages (typosquats, license, known CVEs via OSV) before the edit lands. | features/safety/#new-dependencies-depcheck | done |
| 71 | Local policy-as-code | YAML rules for tools, paths, commands and models, checked on every action, in `.rein/policy.yaml`. | features/safety/#policy-as-code-reinpolicyyaml | done |

## Wave 3: Build, test and CI feedback

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 11 | Touched-targets verify | Typecheck, lint and test only what the turn changed, extending the end-of-turn code check. | features/build-and-test/#testing-what-a-request-changed | done |
| 12 | CI log digest | Turn a long CI or build log into the failing step, root cause and file:line. | features/build-and-test/#digests-of-failing-logs | done |
| 13 | Build-time budget | Warn when a change makes the build or tests noticeably slower than the last recorded run. | features/build-and-test/#slower-builds | done |
| 23 | Official GitHub Action and GitLab component | Published, versioned wrappers for `rein -p` (repo `action.yml`, GitLab CI component). | features/headless/#the-rein-github-action | done |
| 46 | Affected-target analysis | Use Nx, Turborepo, Bazel or Pants (when present) to know what a change affects. | features/build-and-test/#what-a-change-affects | done |
| 47 | Affected-test selection | Run only the tests the dependency graph says can break. Builds on #46. | features/build-and-test/#what-a-change-affects | done |
| 48 | Flaky-test quarantine | Record tests that flip without a code change; keep them out of the agent's pass/fail signal. | features/build-and-test/#flaky-tests | done |
| 49 | Remote build cache | Detect and use Bazel remote cache, Nx Cloud or the Gradle cache in agent builds. | features/build-and-test/#build-caches | done |
| 50 | CI watcher | Watch a PR's checks (`gh`) and fix failures on its own, with the usual approvals. GitLab (`glab`) isn't done yet. | features/build-and-test/#watching-ci | done |
| 51 | Coverage-targeted tests | Generate tests for changed lines no test covers (reads coverage reports). | features/build-and-test/#tests-for-what-you-changed | done |
| 52 | Mutation testing | Check that agent-written tests catch bugs (Stryker, mutmut, go-mutesting when installed). | features/build-and-test/#do-the-tests-catch-bugs | done |

## Wave 4: Review and PR flow

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 14 | Self-review before a PR | A last pass for bugs, security issues and contract breaks before the agent reports done. | features/pull-requests/#a-review-before-its-done | done |
| 15 | Review digest | Plain-language summary of a change with risk areas and test evidence. |  | todo |
| 16 | PR size governor | Above N changed lines, propose splitting the change. |  | todo |
| 17 | Provenance trailers | Commit trailers and PR labels with model, session and goal. | features/pull-requests/#provenance-on-agent-commits | done |
| 25 | Shareable session export | Export a session as one self-contained HTML file (transcript plus diffs). |  | todo |
| 39 | Linked-PR bundle | PRs for one task in several repos link to each other. Builds on #29. |  | todo |
| 63 | Stacked PRs | Split a large change into a stack of dependent PRs. Builds on #16. |  | todo |
| 64 | Answer review comments | Read reviewer comments, fix or reply, push again. |  | todo |
| 65 | PR reviewer in CI | A headless review mode for `rein -p` that comments on PRs. Builds on #23. |  | todo |
| 66 | Merge-queue integration | Work with GitHub, GitLab, Graphite and Mergify merge queues. |  | todo |

## Wave 5: Context at scale

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 9 | Pinned context packs | Named, reusable bundles of files and docs loaded with one command. |  | todo |
| 30 | Repo map | AST summary per repo (symbols, signatures) sized to a token budget. |  | todo |
| 31 | Ownership map | Owners from CODEOWNERS, git history and Backstage catalogs. |  | todo |
| 32 | Workspace memory | Decisions and gotchas remembered per workspace. Builds on #29. |  | todo |
| 33 | Org code search connector | Sourcegraph or Zoekt as a search backend. |  | todo |
| 34 | Local semantic index | Incremental, git-aware embeddings for search by meaning. |  | todo |
| 35 | Synthetic monorepo view | One file tree and search across the workspace's repos. Builds on #29. |  | todo |
| 36 | Sparse and partial clones | Open huge monorepos without checking out everything. |  | todo |
| 37 | Cross-repo rewind | One checkpoint across every repo in the workspace. |  | todo |

## Wave 6: Specs and planning

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 20 | Specs as committed files | Save specs and plans in `.rein/specs/` so they're reviewed in PRs. |  | todo |
| 21 | ADRs | Write architecture decision records; check plans against existing ones. |  | todo |
| 22 | Plan review by a second model | The advisor or the other provider critiques a plan before code is written. |  | todo |
| 53 | Spec mode | Requirements, then design, then tasks, each approved, building on `/plan`. |  | todo |
| 54 | Task graph | A plan as a dependency graph; independent tasks run in parallel subagents. |  | todo |
| 55 | Spec-to-code traceability | Each changed hunk links back to its requirement. Builds on #53. |  | todo |
| 56 | Architecture guardrails | Layering and import rules enforced on every edit. |  | todo |
| 57 | Plan risk score | Files, services, owners and contracts a plan touches. Builds on #31. |  | todo |
| 58 | Best-of-N across providers | Run a task on Claude and Codex at once; keep the result that passes the tests. |  | todo |

## Wave 7: Contracts and migrations

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 38 | Contract-change detector | Classify OpenAPI, protobuf, GraphQL and Avro diffs as breaking or safe. |  | todo |
| 40 | Expand/contract templates | Zero-downtime API and schema changes in safe, ordered steps. |  | todo |
| 41 | Contract test generation | Consumer-driven contract tests (Pact) for service boundaries. |  | todo |
| 42 | Schema migration safety | Flag lock-heavy migrations, missing backfills and irreversible steps. |  | todo |
| 43 | Codemod synthesis | For repetitive changes, write a deterministic script (jscodeshift, OpenRewrite, Comby) instead of hand edits. |  | todo |
| 44 | Migration playbooks | Skills such as Java 8 to 21, Python 2 to 3, React classes to hooks. |  | todo |
| 45 | Dead code and stale-flag campaigns | Find and remove unused code and fully rolled-out flags. |  | todo |

## Wave 8: Sessions, environments and insight

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 24 | Local session analytics | Success rate, retries, time and cost per task from the user's history (`/stats`). |  | todo |
| 59 | Background sessions | Sessions keep running after the terminal closes; reattach from any terminal. |  | todo |
| 60 | Multi-session dashboard | See and steer every running session across repos from one screen. Builds on #59. |  | todo |
| 61 | Environment bootstrap | Start each repo's devcontainer or Nix shell for the agent's commands. |  | todo |
| 62 | ACP server mode | Run Rein as an Agent Client Protocol agent in Zed, JetBrains and other ACP editors. |  | todo |
| 73 | Prompt-cache analytics | Cache hit rates and what breaks the cache. |  | todo |
| 74 | Benchmark on your own repos | `rein bench`: replay tasks from the repo's history to compare models and settings. |  | todo |
| 75 | Onboarding tour | Generate a guided tour of a repo or service. |  | todo |
| 76 | Scheduled jobs | Recurring local runs (dependency bumps, flaky-test triage) on a cron-like schedule. |  | todo |

## Wave 9: System-level understanding

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 105 | Service dependency graph | Which service calls which, from manifests, OpenAPI, protobuf and Kubernetes config. |  | todo |
| 106 | Cross-repo symbol graph | Join language-server and SCIP indexes across repos. |  | todo |
| 107 | API-aware find references | Follow a call from gateway to service to consumer across repos. Builds on #105, #106. |  | todo |
| 108 | Consumer impact report | Every caller of an endpoint or type a change touches, in every repo. Builds on #107. |  | todo |
| 109 | Coordinated change sets | One task becomes linked branches and PRs in N repos, built and tested together. Builds on #29, #39. |  | todo |
| 110 | Codemaps | Browsable, annotated architecture maps, generated and kept fresh. |  | todo |
| 111 | Container sandbox per task | Each task in Docker or Podman with an egress allowlist. |  | todo |
| 112 | Multi-service local stack | Bring up the services a change needs (compose or Helm) with health checks, and test against them. |  | todo |
