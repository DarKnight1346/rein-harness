# Open-source roadmap

The free features from the Rein feature roadmap, in build order. Numbers (`#29`) are the roadmap's feature
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
| 15 | Review digest | Plain-language summary of a change with risk areas and test evidence. | features/pull-requests/#a-digest-for-reviewers | done |
| 16 | PR size governor | Above N changed lines, propose splitting the change. | features/pull-requests/#smaller-prs | done |
| 17 | Provenance trailers | Commit trailers and PR labels with model, session and goal. | features/pull-requests/#provenance-on-agent-commits | done |
| 25 | Shareable session export | Export a session as one self-contained HTML file (transcript plus diffs). | features/pull-requests/#sharing-a-session | done |
| 39 | Linked-PR bundle | PRs for one task in several repos link to each other. Builds on #29. | features/workspaces/#pull-requests-across-repos | done |
| 63 | Stacked PRs | Split a large change into a stack of dependent PRs. Builds on #16. | features/pull-requests/#smaller-prs | done |
| 64 | Answer review comments | Read reviewer comments, fix or reply, push again. | features/pull-requests/#review-comments | done |
| 65 | PR reviewer in CI | A headless review mode for `rein -p` that comments on PRs. Builds on #23. | features/pull-requests/#a-reviewer-in-ci | done |
| 66 | Merge-queue integration | Work with GitHub, GitLab, Graphite and Mergify merge queues. | features/pull-requests/#merge-queues | done |

## Wave 5: Context at scale

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 9 | Pinned context packs | Named, reusable bundles of files and docs loaded with one command. | features/large-codebases/#context-packs | done |
| 30 | Repo map | AST summary per repo (symbols, signatures) sized to a token budget. | features/large-codebases/#a-map-of-the-repo | done |
| 31 | Ownership map | Owners from CODEOWNERS, git history and Backstage catalogs. | features/large-codebases/#who-owns-what | done |
| 32 | Workspace memory | Decisions and gotchas remembered per workspace. Builds on #29. | features/workspaces/#workspace-memory | done |
| 33 | Org code search connector | Sourcegraph or Zoekt as a search backend. | features/large-codebases/#search-the-whole-org | done |
| 34 | Local semantic index | Incremental, git-aware embeddings for search by meaning. | features/large-codebases/#search-by-meaning | done |
| 35 | Synthetic monorepo view | One file tree and search across the workspace's repos. Builds on #29. | features/workspaces/#one-tree-for-every-repo | done |
| 36 | Sparse and partial clones | Open huge monorepos without checking out everything. | features/workspaces/#huge-repos-sparse-and-partial-clones | done |
| 37 | Cross-repo rewind | One checkpoint across every repo in the workspace. | features/rewind/#every-repo-of-a-workspace | done |

## Wave 6: Specs and planning

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 20 | Specs as committed files | Save specs and plans in `.rein/specs/` so they're reviewed in PRs. | features/specs/#reviewed-with-the-code | done |
| 21 | ADRs | Write architecture decision records; check plans against existing ones. | features/specs/#architecture-decisions | done |
| 22 | Plan review by a second model | The advisor or the other provider critiques a plan before code is written. | features/plans/#a-second-opinion-on-the-plan | done |
| 53 | Spec mode | Requirements, then design, then tasks, each approved, building on `/plan`. | features/specs/#three-stages-each-approved | done |
| 54 | Task graph | A plan as a dependency graph; independent tasks run in parallel subagents. | features/specs/#tasks-as-a-graph | done |
| 55 | Spec-to-code traceability | Each changed hunk links back to its requirement. Builds on #53. | features/specs/#requirement-to-code | done |
| 56 | Architecture guardrails | Layering and import rules enforced on every edit. | features/specs/#architecture-guardrails | done |
| 57 | Plan risk score | Files, services, owners and contracts a plan touches. Builds on #31. | features/plans/#how-risky-is-it | done |
| 58 | Best-of-N across providers | Run a task on Claude and Codex at once; keep the result that passes the tests. | features/subagents/#best-of-both-providers | done |

## Wave 7: Contracts and migrations

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 38 | Contract-change detector | Classify OpenAPI, protobuf, GraphQL and Avro diffs as breaking or safe. | features/contracts/#breaking-or-safe | done |
| 40 | Expand/contract templates | Zero-downtime API and schema changes in safe, ordered steps. | features/contracts/#expand-and-contract | done |
| 41 | Contract test generation | Consumer-driven contract tests (Pact) for service boundaries. | features/contracts/#contract-tests-between-services | done |
| 42 | Schema migration safety | Flag lock-heavy migrations, missing backfills and irreversible steps. | features/contracts/#migration-safety | done |
| 43 | Codemod synthesis | For repetitive changes, write a deterministic script (jscodeshift, OpenRewrite, Comby) instead of hand edits. | features/contracts/#codemods-for-repetitive-changes | done |
| 44 | Migration playbooks | Skills such as Java 8 to 21, Python 2 to 3, React classes to hooks. | features/contracts/#migration-playbooks | done |
| 45 | Dead code and stale-flag campaigns | Find and remove unused code and fully rolled-out flags. | features/contracts/#dead-code-and-stale-flags | done |

## Wave 8: Sessions, environments and insight

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 24 | Local session analytics | Success rate, retries, time and cost per task from the user's history (`/stats`). | features/insight/#how-your-requests-go | done |
| 59 | Background sessions | Sessions keep running after the terminal closes; reattach from any terminal. | features/sessions/ | done |
| 60 | Multi-session dashboard | See and steer every running session across repos from one screen. Builds on #59. | features/sessions/#every-session-at-a-glance | done |
| 61 | Environment bootstrap | Start each repo's devcontainer or Nix shell for the agent's commands. | features/tools/#in-the-repos-own-environment | done |
| 62 | ACP server mode | Run Rein as an Agent Client Protocol agent in Zed, JetBrains and other ACP editors. | features/ide/#acp-editors-zed-jetbrains | done |
| 73 | Prompt-cache analytics | Cache hit rates and what breaks the cache. | features/insight/#the-prompt-cache | done |
| 74 | Benchmark on your own repos | `rein bench`: replay tasks from the repo's history to compare models and settings. | features/insight/#benchmark-on-your-own-repo | done |
| 75 | Onboarding tour | Generate a guided tour of a repo or service. | features/insight/#onboarding-tours | done |
| 76 | Scheduled jobs | Recurring local runs (dependency bumps, flaky-test triage) on a cron-like schedule. | features/headless/#scheduled-jobs | done |

## Wave 9: System-level understanding

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 105 | Service dependency graph | Which service calls which, from manifests, OpenAPI, protobuf and Kubernetes config. | features/system/#which-service-calls-which | done |
| 106 | Cross-repo symbol graph | Join the repos' SCIP indexes: definitions in one repo, uses in the others (language servers stay per repo). | features/system/#symbols-across-repos | done |
| 107 | API-aware find references | Follow a call from gateway to service to consumer across repos. Builds on #105, #106. | features/system/#follow-a-call-across-repos | done |
| 108 | Consumer impact report | Every caller of an endpoint or type a change touches, in every repo. Builds on #107. | features/system/#who-a-change-affects | done |
| 109 | Coordinated change sets | One task becomes linked branches and PRs in N repos, built and tested together. Builds on #29, #39. | features/system/#one-change-several-repos | done |
| 110 | Codemaps | Browsable, annotated architecture maps, generated and kept fresh. | features/system/#codemaps | done |
| 111 | Container sandbox per task | Each task in Docker or Podman with an egress allowlist. | features/system/#a-container-per-task | done |
| 112 | Multi-service local stack | Bring up the services a change needs (compose or Helm) with health checks, and test against them. | features/system/#the-services-a-change-needs | done |

## Wave 10: Marketplace

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 118 | Marketplace repos | A GitHub repo laid out as a marketplace (Rein's `rein.json` items, or a Claude Code `marketplace.json`) becomes a catalog. `/marketplace add <gitRepoUrl>`, `/marketplace list`, `/marketplace remove <gitRepoUrl>`, `/marketplace update`. The official Rein Marketplace (github.com/rein-harness/rein-marketplace) is always there and can't be removed. | features/marketplace/#commands | done |
| 119 | Marketplace store | `/marketplace` opens the full catalog in a window like a store: categories (tools, commands, skills, UI, features, bundles), search, a page per item with what it adds, install, update and uninstall. Builds on #118. | features/marketplace/#the-store | done |
| 120 | Marketplace items | An item adds tools (MCP servers), commands, skills, subagents, hooks, UI customization (theme, status line, sidebar) or settings, or is a bundle of other items. Installed items live in `~/.rein/plugins/` and load like plugins. Builds on #118. | features/marketplace/#what-an-item-can-be | done |

## Wave 11: Web UI

| # | Feature | Spec | Docs | Status |
|---|---|---|---|---|
| 113 | Web UI server | `rein --ui` serves a web UI on port 9333; `rein --ui --port <number>` picks another. The same engine, accounts, tools and approvals as the TUI, through the official CLIs. | features/web-ui/ | done |
| 114 | Web UI as a system service | `rein service --install [--port <number>]` installs the web UI as a service that starts with the system (launchd on macOS, a systemd user unit on Linux, a scheduled task on Windows); `rein service --uninstall` removes it. | features/web-ui/#as-a-service | done |
| 115 | First-run setup | The first visit walks through setup: no login (local only, or reached through a Tailscale tunnel), or with login credentials, for running it on your own server. | features/web-ui/#first-run | done |
| 116 | Desktop-style chat | Conversations like Claude Desktop or ChatGPT desktop: a sidebar of chats per project, streaming replies, tool calls, diffs, approvals, plans, goals, subagents and model choice, on any device. Builds on #113. | features/web-ui/#chats | done |
| 117 | File manager | Open any directory on the machine as a project, from a full file manager for headless servers: browse, search, preview, edit, upload, download, rename, move, copy, delete and new folders. Builds on #113. | features/web-ui/#files | done |
| 121 | Web UI parity: commands and chrome | Everything typed goes through the terminal's command code: every slash command, skill and `!command`, with the same fuzzy `/` list. `/settings` (every tab and config key) and `/model` open as windows; the status line and sidebar follow the `/settings` layout, with marketplace items' segments and sections; messages typed mid-turn are queued. Builds on #116. | features/web-ui/#slash-commands | done |
| 122 | Web UI parity: rewind, shells, subagents | `/rewind` (code, conversation or both, the message back in the box), `/shells` and `/shell` (output that follows a running command, stop it), and `/agents` (follow a subagent, message it, stop it) as windows in the browser. Builds on #121. | features/web-ui/#slash-commands | done |
