---
title: Slash commands
description: Every built-in Rein slash command, its arguments and aliases, plus the built-in skills that ship with Rein.
---

Type `/` in the input to see the list. A bare `/` shows the everyday commands, most-used first (`/model`, `/goal`, `/plan`, `/review`…), then your own skills. Typing searches everything, fuzzily and best match first, including the variants and diagnostics left out of the bare list (`/plan:deep`, `/review:deep`, `/skill:edit`, `/goal:plan`, `/agent`, `/tui`, `/voice`, `/lsp`, `/plugins`) and skills from Claude Code and Codex plugins. **Tab** or **Enter** fills in the highlighted entry so you can add arguments, and a command typed out in full runs right away. You can also click an entry in fullscreen. `/help` shows every command with its arguments.

Rein has **33 built-in commands** and **7 built-in skills**, plus **36 commands and 7 skills in [packs](#packs)** that are off until you turn them on. Commands are handled by Rein itself. Skills are prompts sent to the agent (see [Built-in skills](#built-in-skills)).

## While the agent is working

The input stays live while the agent works:

- **Plain messages and skills queue.** They're sent when the current reply finishes, and the working line shows `N queued`.
- **`/btw` runs immediately**, on the side.
- **`/clear`, `/compact`, `/tui`, `/update` and `/resume` wait.** If you run one while the agent is busy, Rein says `/<name> waits until the agent is idle (esc interrupts it).` and does nothing. Press Esc first.
- **`/rewind`** also refuses while the agent is working: `The agent is working — press esc to stop it first, then /rewind.`
- Every other command runs at once.

When you're [viewing a subagent](../../features/subagents/), `/compact`, `/rewind`, `/clear` and `/resume` are refused, because they act on the main conversation. Switch back with `/agent main` first.

In fullscreen, commands that show information open a window over the conversation, which keeps streaming underneath. In the classic renderer the same information is printed into the history.

## Commands

### Conversation

| Command | Arguments | What it does |
|---|---|---|
| `/clear` | — | Clears the conversation and stops every subagent. *Waits for idle.* |
| `/compact` | `[what to keep]` | Summarizes the conversation with the compaction model and keeps the last two messages as-is. With text (`/compact keep the API design decisions`), the summary keeps that in full detail. The agent can bring summarized parts back with `recall`. *Waits for idle.* → [Compaction](../../internals/context/#compaction) |
| `/context` | — | Shows what the context holds and how full it is, as a grid that refreshes every second while open, with the largest items (instruction files, tool results, the summary) listed below it. When viewing a subagent, shows the subagent's context. |
| `/resume` | — | Picks a saved conversation from this project to continue. *Waits for idle.* |
| `/rewind` | — | Restores files and/or the conversation to before one of your messages. Also **Esc Esc** with an empty input. |
| `/btw` | `<question>` | Asks a side question. A fork of the agent answers without interrupting it, and the answer is not added to the conversation. Runs immediately, even mid-reply. |

### Goals and plans

| Command | Arguments | What it does |
|---|---|---|
| `/goal` | `<text>` | Sets a goal. The agent keeps working until the decision model verifies it's done (evidence required). |
| | *(none)* | Shows the current goal: a window in fullscreen, a summary in classic. |
| | `pause` | The current turn finishes, then the agent stops working on the goal. |
| | `resume` | Continues a paused goal. |
| | `clear` | Removes the goal. |
| `/goal:plan` | — | Starts a saved, unfinished plan from `.rein/plans/` as a goal, with milestones tracked in the sidebar. You can also start planning a new one from the same window, which puts `/plan ` in the input. |

See [Goals](../../features/goals/) and [Plan mode](../../features/plans/).

### Models, accounts and usage

| Command | Arguments | What it does |
|---|---|---|
| `/model` | *(none)* | Opens **Models** with sections Chat model, Subagents, Subagent priority, Decision model, Compaction model, Advisor and Web. Choosing a chat model continues to its effort level. |
| | `auto` | Sets the chat model to auto routing. |
| | `<model>` | Sets the chat model. Accepts a `provider:model` ref or a model's id or label as shown in `/model`, case-insensitive. |
| `/voice` | `setup` | [Voice input](../../features/voice/) on your machine (whisper.cpp). Shows what's installed, or, once set up, starts or stops a recording (like a tap of Ctrl+Space). `setup` installs what's missing (Homebrew on macOS) and downloads the speech model (about 60 MB, once). |
| `/remote` | `on` · `pair` · `status` · `unpair` · `off` | Use this session from your phone or another computer: starts a page Rein serves (on this computer only, reach it through a tunnel) and shows a pairing code. → [Remote access](../../features/remote/) |
| `/vault` | `set NAME` · `rm NAME` | Secrets the agent can use in shell commands as `$NAME` without seeing them. Lists the names; `set` asks for the value in a hidden field; `rm` removes one. → [Secrets vault](../../features/vault/) |
| `/lsp` | `stop` | Built-in code intelligence: the language servers Rein is running (memory, open files, idle time), and which are installed and where. `stop` shuts them down (they start again when needed). → [Code intelligence](../../features/code-intelligence/) |
| `/pet` | `[<name> \| add <sheet> [name] \| off \| refresh]` | Your [pet](../../features/pets/) in the sidebar: your own (on this machine) or your ChatGPT account's. Lists them, picks one, adds a sprite sheet, or hides it. |
| `/plugins` | — | Lists the Claude Code and Codex plugins Rein loaded, and what each adds (commands, agents, hooks, MCP servers), plus Codex skills. → [Plugins](../../features/plugins/) |
| `/login` | — | Lists accounts; adds Claude (subscription, Console API key, Bedrock, Vertex) or Codex (ChatGPT, OpenAI API key) accounts; re-authenticates or removes them; manages the Jev API key. → [Accounts](../../features/accounts/#api-accounts-pay-per-use) |
| `/usage` | *(none)* | Usage windows (5h / weekly / 30-day) and reset times for every account. |
| | `refresh` | Re-checks now. Claude accounts send a tiny request on their cheapest model to get fresh numbers. |

### Agents and shells

| Command | Arguments | What it does |
|---|---|---|
| `/agents` | — | The subagents the agent has spawned. Pick one to view and message it (`k` stops one). Classic prints the list. |
| `/agent` | `<id>` | Fullscreen: switches the main pane to that subagent. Classic: prints its status and report. |
| | `main` *(or none)* | Switches back to the main agent. |
| | `<id> <message>` | Sends a message to that subagent (useful in classic). |
| `/shells` | *(none)* | Shell commands the agent started. Open one to see its logs (`k` kills it). |
| | `<id>` | Opens that shell's logs directly. |

### Project and permissions

| Command | Arguments | What it does |
|---|---|---|
| `/cost` | — | What the conversation, the latest request and the current goal cost at API list prices, with token totals. See [Cost & budgets](../../features/cost/). |
| `/add-dir` | `<path>` | Adds a working directory the agent can use without asking, for this session. Another repo's own `AGENTS.md` / `CLAUDE.md` is delivered the first time the agent works in it. |
| | *(none)* | Lists the current working directories. |
| `/permissions` | — | Lists the allow/deny rules in effect, grouped by the settings file they come from. |
| `/ide` | `reconnect` | Editor integration: shows the connected editor (VS Code, Cursor, Windsurf or JetBrains, through the Claude Code extension) and what's selected, or connects to one. → [Editor integration](../../features/ide/) |
| `/memory` | — | Shows the project's memory (`.rein/MEMORY.md`): the facts Rein has learned here. |
| `/marketplace` | `[add <gitRepoUrl> \| list \| remove <gitRepoUrl> \| update [all \| <id>…] \| install <id> \| uninstall <id>]` | The [marketplace](../../features/marketplace/): no argument opens the store (tools, commands, skills, themes, features, bundles); the rest manage your marketplace repos and installed items; `update` lets you pick which installed items to update (or `update all`). The official Rein Marketplace can't be removed. |
| `/mcp` | — | MCP servers with status and tools. Enter approves a waiting project server or reconnects one. |

### Rein itself

| Command | Arguments | What it does |
|---|---|---|
| `/settings` | `[<tab>]` | Settings in eight tabs: Status line, Sidebar, General, Agents, Accounts, Safety, Packs and Advanced. `/settings safety` opens on that tab. See [Configuration](../configuration/#the-settings-tabs). |
| `/settings` | `keys` · `<key> [<value> \| reset]` | Any setting in `~/.rein/config.json` from the prompt: `keys` lists them all, `<key>` explains one (meaning, choices, default), `<key> <value>` sets it (`true`/`false`, a number, a listed choice, a comma-separated list, or JSON), `<key> reset` restores the default. Applies live. See [Configuration](../configuration/). |
| `/settings` | `export [file]` · `import <file>` | Moves your settings to another machine: `export` writes them to a file, `import` reads one. Accounts, logins, the vault and keys are never included. |
| `/tui` | `fullscreen` \| `classic` | Switches renderer and carries the conversation over. With no argument, shows which renderer is active. *Waits for idle.* |
| `/update` | — | Updates the `claude` and `codex` CLIs, checks the Codex app-server protocol, then updates Rein. *Waits for idle.* |
| `/export` | `[file]` | Saves the whole conversation as Markdown (every message, each reply's tool calls as a list) and copies it to the clipboard. Default file: `~/.rein/exports/<id>.md`; a path is relative to the project. |
| `/export html` | `[file]` | The conversation as one self-contained HTML page (default `~/.rein/exports/<id>.html`) with its tool calls and their diffs, to attach to a PR or ticket. HTML in the conversation is shown as text, never run. See [Sharing a session](../../features/pull-requests/#sharing-a-session). |
| `/help` | — | Commands and skills. |
| `/exit` | — | Quits. Ctrl+C twice also exits. |

Rein has no command aliases. An unknown command prints `Unknown command /<name>. Try /help.`

## Packs

Specialist commands and skills come in **packs**, and every pack is **off** until you turn it on in `/settings` → **Packs** (or list it in [`packs`](../configuration/) in `config.json`). A pack that's off keeps its commands out of the `/` list and `/help`, and its skills away from the agent. Typing one of its commands says where it is:

```text
/impact is in the Multi-repo systems pack, which is off. Turn it on in /settings → Packs (or add "system" to packs in config.json).
```

### CI and pull requests (`ci`)

| Command | Arguments | What it does |
|---|---|---|
| `/ci` | `[watch \| stop]` | The checks on this branch's pull request (GitHub, through `gh`). `watch` checks every minute and hands failures, with their digested logs, to the agent to fix (3 rounds at most; it asks before pushing). See [Watching CI](../../features/build-and-test/#watching-ci). |
| `/pr` | `[digest [post] \| split \| comments \| queue [yes]]` | This branch's pull request (GitHub, through `gh`): status; a digest for reviewers (`post` adds it as a comment); `split` asks the agent to split the branch into stacked PRs; `comments` hands review comments to the agent; `queue` shows and `queue yes` runs the merge-queue command. See [Pull requests](../../features/pull-requests/#pr). |
| `/affected` | — | What your working tree's changes affect, from the monorepo's build graph (Nx, Turborepo, Bazel, Pants), and the command that tests just that. See [Build & test](../../features/build-and-test/#what-a-change-affects). |
| `/flaky` | `[clear]` | The tests known to be flaky in this project (they failed and passed on the same code), recorded with the `flaky-quarantine` experiment. `clear` forgets them. See [Flaky tests](../../features/build-and-test/#flaky-tests). |
| `/build` | — | The build system here (Nx, Turborepo, Bazel, Pants), the build caches it's set up with, and whether the sandbox lets agent builds use them. See [Build caches](../../features/build-and-test/#build-caches). |
| `/coverage` | `[tests]` | Lines your changes add that no test ran, from the newest coverage report (lcov, Istanbul, Cobertura, Go). `tests` asks the agent to write tests for them. See [Tests for what you changed](../../features/build-and-test/#tests-for-what-you-changed). |
| `/mutate` | `[tests]` | Mutation testing of your changed files (Stryker, mutmut, go-mutesting): which planted bugs the tests miss. `tests` asks the agent to tighten the tests. See [Do the tests catch bugs?](../../features/build-and-test/#do-the-tests-catch-bugs). |
| `/trackers` | `check` · `retry <ref>` | Issue trackers handing work to Rein (GitHub, Linear, GitLab, Azure DevOps, Jira): what's set up and what's been taken; `check` looks now; `retry` lets an issue be taken again. → [Issue trackers](../../features/trackers/) |

### Specs and planning (`specs`)

| Command | Arguments | What it does |
|---|---|---|
| `/spec` | `<what>` · `resume <name>` · `trace <name>` | [Spec mode](../../features/specs/): the agent writes requirements, a design and tasks for `<what>`, and you approve each in turn before any code changes. Without arguments, lists the specs in `.rein/specs/`. `resume` picks one up where it stopped (or carries out its tasks once they're approved); `trace` shows which code meets each requirement |
| `/adr` | `[new <title>]` | Lists the [architecture decision records](../../features/specs/#architecture-decisions) in `docs/adr/` (or wherever `.adr-dir` points) with their status. `new <title>` creates the next numbered one from a template and has the agent fill it in |
| `/arch` | — | Checks every JS/TS, Python and Go file against the [architecture rules](../../features/specs/#architecture-guardrails) in `.rein/architecture.yaml` and lists the imports that break them |
| `/risk` | `[<plan file> \| <spec name>]` | What a plan touches: the files it names, and across how many services, repos and owners, with any contracts (OpenAPI, protobuf, GraphQL…) and migrations among them, scored low, medium or high. Defaults to the newest saved plan. See [How risky is it](../../features/plans/#how-risky-is-it) |
| `/bestof` | `[--test "<command>"] <task>` | Runs the task on the best available Claude model and the best Codex model at once, each in its own worktree, then runs the tests in both and keeps the result that passes (the smaller change if both do). See [Best of both providers](../../features/subagents/#best-of-both-providers) |

### Contracts and migrations (`migrations`)

| Command | Arguments | What it does |
|---|---|---|
| `/contracts` | — | Lists the API contracts (OpenAPI, Swagger, protobuf, GraphQL, Avro) this branch changes against its base, each change marked breaking or safe. See [Contracts & migrations](../../features/contracts/#breaking-or-safe) |
| `/migrations` | — | Checks the database migrations this branch adds or changes for steps that lock big tables, need a backfill they don't have, can't be undone, or break code still running mid-deploy, each with the safer way. See [Migration safety](../../features/contracts/#migration-safety) |
| `/deadcode` | `[remove]` | Lists exported and top-level definitions (JS/TS, Python, Go) that nothing else refers to. `remove` has the agent check each one and delete what's really unused. See [Dead code and stale flags](../../features/contracts/#dead-code-and-stale-flags) |
| `/flags` | `[remove <key>]` | Lists the feature flags the code reads (LaunchDarkly, Unleash, OpenFeature, GrowthBook, Flagsmith, Split, Flipper), marking stale ones: fully on or off in the repo's flag files, or 90+ days old. `remove <key>` has the agent remove one, keeping the live branch |

Skills in this pack:

| Skill | Arguments | What it does |
|---|---|---|
| `/codemod` | `<change>` | Makes a repetitive change across many files with a deterministic script (jscodeshift, ts-morph, OpenRewrite, LibCST, Comby…): tried on a few files, then run on all, then checked. See [Codemods](../../features/contracts/#codemods-for-repetitive-changes) |
| `/expand-contract` | `<change>` | Plans a breaking API or schema change (rename, retype, split, remove) as expand, migrate and contract steps, each safe to deploy alone, with backfills, verification and rollback per step. Turns on plan mode. See [Expand and contract](../../features/contracts/#expand-and-contract) |
| `/contract-tests` | `[boundary]` | Writes consumer-driven contract tests with [Pact](https://pact.io) for the services this one calls (or the boundary you name), and provider verification when the provider is in your workspace. Asks before adding Pact. See [Contract tests](../../features/contracts/#contract-tests-between-services) |
| `/migrate:java21` | `[details]` | Plans a move from Java 8, 11 or 17 to 21 in phases that each ship alone: build tool and plugins, dependencies, removed and encapsulated APIs, the target version, then optional modern features. Plan mode. See [Migration playbooks](../../features/contracts/#migration-playbooks) |
| `/migrate:python3` | `[details]` | Plans a Python 2 to 3 move: a test safety net, a reviewed codemod pass, the bytes/text and division fixes by hand, dependencies, running on both, then dropping Python 2. Plan mode |
| `/migrate:react-hooks` | `[components]` | Plans converting class components to function components with hooks, leaves first, behaviour pinned by tests; error boundaries stay classes. Plan mode |

### Multi-repo systems (`system`)

| Command | Arguments | What it does |
|---|---|---|
| `/services` | `[mermaid]` | Which service calls which, with the file and line behind each link: docker-compose, Kubernetes config, URLs and `*_URL` settings, gRPC clients and internal packages. `mermaid` prints it as a diagram. See [Your whole system](../../features/system/#which-service-calls-which) |
| `/symbols` | `[<name> \| cross \| index]` | Symbols across repos, from their SCIP indexes: `<name>` shows where it's defined and every use; `cross` (the default) lists symbols used outside the repo that defines them; `index` writes each repo's `index.scip` with its language's indexer, where installed. See [Symbols across repos](../../features/system/#symbols-across-repos) |
| `/refs` | `<endpoint or RPC>` | Follows an endpoint (`POST /orders/{id}`) or gRPC method (`Ledger.Post`) across repos: the gateway route in front of it, where it's served, and every caller. See [Follow a call across repos](../../features/system/#follow-a-call-across-repos) |
| `/impact` | — | Every caller, in every repo, of what this branch changes: endpoints and RPCs (from the contract changes) and exported functions and types (from the diff), breaking changes first. See [Who a change affects](../../features/system/#who-a-change-affects) |
| `/changeset` | `start <name> [repo…]` · `status` · `test` · `pr [yes]` `[name]` | One change across several workspace repos: the same branch in each, built and tested together in dependency order, and pull requests that link to each other (`pr` shows what it would do; `pr yes` pushes and opens them). See [One change, several repos](../../features/system/#one-change-several-repos) |
| `/codemap` | `[status \| annotate \| rebuild]` | Writes or refreshes the architecture map in `docs/codemap/`: an index with the service graph, and a page per service (APIs, calls and callers, owners, entry points, layout, key declarations). Only changed services are rewritten; notes are kept. `status` says what's stale, `annotate` has the agent write the missing notes. See [Codemaps](../../features/system/#codemaps) |
| `/stack` | `up [services] \| up --helm <chart> \| status \| logs <service> \| down` | Runs the services a change needs locally with Docker Compose (the ones your branch touches, with their `depends_on`), waits for their health checks and lists their ports. Helm charts only go into a local cluster. See [The services a change needs](../../features/system/#the-services-a-change-needs) |

### Large codebases (`codebase`)

| Command | Arguments | What it does |
|---|---|---|
| `/workspace` | `[clone \| sparse [<repo> <folder…>] \| prs \| link-prs [yes]]` | Lists the repos of this [workspace](../../features/workspaces/) (`rein.workspace.yaml`), which are cloned and what each does. `clone` clones the missing repos that have a `url`. `sparse` shows each repo's checkout, and `sparse <repo> <folder…>` checks out more of a sparse one (see [Huge repos](../../features/workspaces/#huge-repos-sparse-and-partial-clones)). `prs` lists the current branch's pull request in each repo; `link-prs yes` links them to each other (see [Pull requests across repos](../../features/workspaces/#pull-requests-across-repos)). |
| `/scope` | `[<dir> \| off]` | Works in one package of a monorepo: `list`, `search` and `shell` start in `<dir>`, its `AGENTS.md` files load, and the code check skips callers outside it. `off` clears it; no argument shows it. Same as `rein --scope <dir>`. |
| `/owners` | `[path]` | Who owns your changed files (or a path): CODEOWNERS, then Backstage `catalog-info.yaml`, then git history. See [Who owns what](../../features/large-codebases/#who-owns-what). |
| `/index` | `[<query>]` · `status` | Builds or updates the [local semantic index](../../features/large-codebases/#search-by-meaning) through Ollama (only changed files are embedded again). `/index <query>` searches it; `status` shows its size and model |
| `/map` | `[send]` | A map of the repo: each source file's top-level declarations, within about 4,000 tokens. `send` gives it to the agent. See [A map of the repo](../../features/large-codebases/#a-map-of-the-repo). |
| `/pack` | `[<name> [message] \| save <name> <globs…>]` | Context packs (`.rein/packs.yaml`): no argument lists them; `<name>` attaches a pack's files (like `@path`, up to 40) with your message; `save` makes one. See [Context packs](../../features/large-codebases/#context-packs). |

### Insight and automation (`insight`)

| Command | Arguments | What it does |
|---|---|---|
| `/stats` | `[days] [all]` | How your requests go, from the conversations saved on this machine: time per request, tool calls, failures and retries, how often the tests passed at the end, and cost, overall and per model. This project and 30 days by default; `all` covers every project. See [Insight](../../features/insight/#how-your-requests-go) |
| `/cache` | `[days] [all]` | Prompt-cache hit rates per model, and what made the cache cold: first messages, compactions, rewinds, account, provider or model switches, fresh sessions that carried the context, idle gaps past the cache lifetime. See [The prompt cache](../../features/insight/#the-prompt-cache) |
| `/schedule` | — | The [scheduled jobs](../../features/headless/#scheduled-jobs) in `.rein/schedule.yaml`: when each runs next and how its last run went. `rein schedule install` (in a terminal) runs them on time |
| `/env` | `[up]` | The dev environment the agent's commands run in (dev container, Nix or devbox shell) and its state; `up` starts it now instead of at the first command. See [In the repo's own environment](../../features/tools/#in-the-repos-own-environment) |
| `/sessions` | `[send <pid> <message>]` | Every other Rein running on this machine, across repos, with its state (idle, working, waiting for you), folder, title and goal. `send` sends one a message, as if typed there. See [Every session at a glance](../../features/sessions/#every-session-at-a-glance) |
| `/policy` | — | Shows the policy in force (`.rein/policy.yaml`, `~/.rein/policy.yaml`): its deny and ask rules, allowed and denied models, and mistakes in the files. See [Policy as code](../../features/safety/#policy-as-code-reinpolicyyaml). |

Skills in this pack:

| Skill | Arguments | What it does |
|---|---|---|
| `/tour` | `[what]` | Writes a guided onboarding tour of the repo (or the service or feature you name): 8–20 stops in reading order, each a real file and line, as a [CodeTour](https://github.com/microsoft/codetour) in `.tours/` and a markdown page. See [Onboarding tours](../../features/insight/#onboarding-tours) |

## Shell commands with `!`

Start a message with `!` to run a shell command yourself, like Claude Code's bash mode: `!npm test`, `!git status`. It runs in the project with no approval (you typed it), its output shows live under the input, and the command plus its output go along with your next message so the agent knows what you ran. Ctrl+C stops it.

## Built-in skills

These entries look like commands but are **skills**. Each one sends a prepared prompt to the agent, so it queues like a message while the agent is busy. Skills from your project, your home folder or a plugin are tagged with where they come from in the list.

| Skill | Arguments | What it does |
|---|---|---|
| `/init` | `[guidance]` | Has the agent look through the project and write (or improve) `AGENTS.md`: what the project is, the real build/test/lint commands, a map, conventions and gotchas. With a `CLAUDE.md` but no `AGENTS.md`, it moves the shared rules into `AGENTS.md` and leaves `CLAUDE.md` as an `@AGENTS.md` import. |
| `/plan` | `<task>` | Plans a change before making it. Turns plan mode on, and the agent explores read-only, asks you questions, then presents a plan for approval. |
| `/plan:deep` | `<task>` | Thorough planning for big or risky changes: deeper exploration (parallel subagents), more questions and advisor reviews, then a plan for approval. Also turns on plan mode. |
| `/review` | `[what to review]` | Reviews the current changes (uncommitted plus this branch's commits; the whole project if there are none, or whatever you name) for bugs, security issues, test coverage gaps and copyright/licensing problems. One read-only reviewer per area, each on the single best model for it. The agent checks every finding against the code, drops what doesn't hold up, reports the rest, and asks which to fix. Nothing is fixed unless you pick it. → [Reviewing code](../../features/skills/#reviewing-code-review-and-reviewdeep) |
| `/review:deep` | `[what to review]` | The thorough version, in plan mode: a reviewer per area **on each provider you're signed into**, each on that provider's best model for the area. Findings are merged, checked against the code, then checked with the [advisor](../../features/subagents/) and with you. You pick which to fix (none is fine), and only those go into a `/plan:deep`-style plan for approval. |
| `/skill:create` | `<what it should do>` | Has the agent create a new Rein skill, global or for this project. |
| `/skill:edit` | `<skill and change>` | Has the agent edit an existing Rein skill. |

Your own skills from `<project>/.rein/skills/` and `~/.rein/skills/` appear in the same list. When names clash, the built-in wins, then the project skill, then the global one. A skill named like a built-in command is hidden, and Rein tells you at startup (`Skill "…" hidden by built-in command; rename to use it.`). See [Skills](../../features/skills/).

## Related

- [Keyboard & mouse](../keys/)
- [CLI flags](../cli/)
- [Your first session](../../start/first-session/)
