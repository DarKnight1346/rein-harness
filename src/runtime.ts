import {existsSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {run} from './util/proc.js';
import {extensions} from './extensions/index.js';
import {ripgrep} from './tools/fs.js';
import {EventEmitter} from 'node:events';
import {adapters} from './providers/index.js';
import {onSideUsage} from './providers/usage.js';
import {formatUsd, setCacheWriteTtl, setPriceOverrides} from './providers/prices.js';
import {Telemetry} from './telemetry/otel.js';
import {maskSecrets} from './tools/secrets.js';
import {sastCheck} from './tools/sast.js';
import {classify, contractNote} from './contracts/changes.js';
import {isMigration, lintMigration, migrationNote} from './contracts/migrations.js';
import {loadPolicy, modelBlocked} from './policy.js';
import {reinConfigDir} from './store/paths.js';
import {affectedTool} from './build/tool.js';
import {repoMapTool} from './context/repoMap.js';
import {orgSearchTool} from './context/orgSearch.js';
import {semanticSearchTool} from './context/semantic.js';
import {apiRefsTool, serviceGraphTool, symbolRefsTool} from './system/tools.js';
import {affected, changedFiles} from './build/affected.js';
import {CiWatcher} from './build/ci.js';
import {branchSize} from './pr/github.js';
import {digestLog, formatDigest} from './tools/logDigest.js';
import {isTestCommand} from './build/flaky.js';
import {effectiveBudget, overBudget, type Spend} from './budget.js';
import {catalog, toRef} from './router/catalog.js';
import {mergeNote, repoTop, Worktrees} from './agents/worktrees.js';
import {shellFor} from './util/platform.js';
import {bestOf as runBestOf, formatBestOf} from './agents/bestOf.js';
import type {Origin} from './tools/fs.js';
import {makeRouter, type AutoRouter} from './router/index.js';
import {samplingHandler} from './mcp/sampling.js';
import {recallTool} from './tools/recall.js';
import type {RemoteServer} from './remote/server.js';
import {makeTracker} from './trackers/index.js';
import type {Issue, TrackerConfig} from './trackers/types.js';
import {issueTask, TrackerWatcher} from './trackers/watcher.js';
import {sendWebhook} from './ui/terminal/webhook.js';
import {LspManager, type Before} from './lsp/manager.js';
import {installable, installServer, serverById, SERVERS} from './lsp/servers.js';
import {makeAutoRouter} from './router/auto.js';
import {Engine} from './session/engine.js';
import {compactTranscript, type CompactReason, type CompactResult} from './session/compactor.js';
import {loadTranscript, type Transcript} from './session/transcript.js';

/** `true` = show the picker, a string = continue that session id, `false` = new conversation. */
export type Resume = boolean | string;
import {activeExperiments, DEFAULT_CONFIG, loadConfig, saveConfig, type Config} from './store/config.js';
import {usageStore} from './store/usage.js';
import {SubagentManager, SUBAGENT_PROMPT, type Subagent} from './agents/manager.js';
import {agentTools} from './agents/tools.js';
import {advisorRef, advisorTool} from './agents/advisor.js';
import {GoalManager} from './goals/manager.js';
import {Checkpoints} from './session/checkpoints.js';
import {WorkspaceSnapshots} from './session/snapshots.js';
import {DevEnv} from './env/devenv.js';
import {ContainerBox} from './env/container.js';
import {LocalStack, servicesForChange, stackTool} from './env/stack.js';
import {findServices} from './system/services.js';
import {SPEC_MODE_CONTEXT, specTools} from './specs/tools.js';
import {specSection} from './specs/pr.js';
import {adrContext} from './specs/adr.js';
import {McpManager} from './mcp/manager.js';
import {mcpTools} from './mcp/tools.js';
import {skillTool} from './skills/tool.js';
import {memoryTools} from './tools/memory.js';
import {PLAN_MODE_CONTEXT, presentPlanTool, type PlanDecision, type PresentedPlan} from './tools/plan.js';
import {askUserTool, type AskAnswer, type AskQuestion} from './tools/ask.js';
import {decideTool} from './decider/tool.js';
import {startUsageRefresh} from './accounts/usage.js';
import path from 'node:path';
import {findIdes, IdeConnection} from './ide/connection.js';
import {hasHooks, runHooks} from './hooks.js';
import {goalDoneTool, milestoneDoneTool} from './goals/tool.js';
import {webTools} from './tools/web.js';
import {isMilestoneCopy, todoTool} from './tools/todo.js';
import {imageGenRef, imageTool} from './tools/image.js';
import {newTranscript, saveTranscript, setSaveFilter} from './session/transcript.js';
import {setPromptCacheTtl} from './providers/claude/session.js';
import {setEnabledPacks} from './commands/packs.js';
import {setExtensionCommands} from './commands/index.js';
import {Pets} from './pets/index.js';
import {loadSkills} from './skills/index.js';
import {petTools} from './pets/tools.js';
import {setAttribution, setBriefFinal, setCheapExplore, setExtraWorkingDirs, setInScope, setProvenance, setScopeDir, setLazyTools, setManyCalls, setNoTodo, setSelfTest, setVaultNames, systemPrompt} from './session/prompt.js';
import {Vault} from './vault/vault.js';
import {parseRef, refKey, type Account, type ModelRef, type TokenCount, type ToolBinding} from './providers/types.js';
import {removeAccount} from './accounts/service.js';
import {releaseCodexAccount} from './providers/codex/adapter.js';
import {completeWith, decide, resolveUtilityModel} from './decider/index.js';
import {parseIndices} from './session/carry.js';
import {headTail} from './router/auto.js';

/** `auto` approval mode: allow without asking only at this confidence or higher. */
const AUTO_APPROVE_MIN = 0.85;
/** Plan mode: how sure the decision model must be that an unlisted command only reads. */
const READ_ONLY_MIN = 0.85;
import {mcpProxyCommand, ToolHost, type ApprovalDecision, type ApprovalRequest, type ToolActivity} from './tools/host.js';
import {findWorkspace, workspaceDirs, type Workspace} from './workspace/index.js';

/** Process-wide state shared by the UI and commands. */
/** keep-going: times per request the agent is sent back after stopping partway. */
const KEEP_GOING_MAX = 3;
/** verify-requirements: checks per request (the second only when the first one changed the code). */
const VERIFY_MAX = 2;

export class Runtime {
  config: Config = DEFAULT_CONFIG;
  /** The workspace (rein.workspace.yaml) the launch folder belongs to, if any. */
  workspace: Workspace | undefined;
  /** /ci watch: what to send the agent, refreshed by the UI on every render (it owns the chat). */
  ciSubmit: (task: string) => void = () => {};
  /** A line for you (not the agent) in the conversation view, set by the UI. */
  uiLog: (text: string, kind?: 'info' | 'error') => void = () => {};
  /** devEnvironment: the repo's dev container or Nix/devbox shell for the agent's commands. */
  /** sandbox "container": a Docker/Podman container per conversation for the agent's commands. */
  readonly box = new ContainerBox(() => [process.cwd(), ...workspaceDirs(this.workspace)], () => this.config?.containerSandbox ?? {}, undefined, (t) => this.uiLog(t));
  readonly devEnv = new DevEnv(process.cwd(), () => this.config?.devEnvironment ?? 'off', undefined, (t) => this.uiLog(t));
  readonly ci = new CiWatcher({log: (t, k) => this.uiLog(t, k), submit: (t) => this.ciSubmit(t)});
  /** OpenTelemetry export (config `otel`). */
  readonly telemetry = new Telemetry(() => this.config);
  /** The conversation's cost when the user's latest message arrived (for /cost's "this request"). */
  requestStartUsd = 0;
  /** --scope / /scope: the package of a monorepo this session works in (absolute), if any. */
  scope: string | undefined;

  /** Whether sast and verify-affected have checked this request's changes. */
  private sastChecked = false;
  /** contract-check ran for this request. */
  private contractsChecked = false;
  /** migration-check ran for this request. */
  private migrationsChecked = false;
  private affectedChecked = false;
  private sizeChecked = false;
  /** The last budget stop (for rein -p's exit status), cleared by your next message. */
  budgetStop: string | undefined;

  /** What this conversation, the latest request and the goal have spent (USD), for budgets. */
  private spend(): Spend | undefined {
    const usd = this.engine?.sessionTokens.usd;
    if (usd === undefined) return undefined;
    const goal = this.goals.goal;
    return {conversation: usd, request: usd - this.requestStartUsd, goal: goal?.status === 'active' && goal.startUsd !== undefined ? usd - goal.startUsd : undefined};
  }

  /** A cap reached: stop (the engine interrupts the turn), pausing the goal so it doesn't continue. */
  private checkBudget(): string | undefined {
    const spend = this.spend();
    const msg = spend && overBudget(spend, effectiveBudget(this.config.budget));
    if (!msg) return undefined;
    this.budgetStop = msg;
    if (this.goals.goal?.status === 'active') this.goals.pause();
    return msg;
  }

  /** verify-affected: run the affected tests; a failure as the message for the agent (undefined: they passed or nothing to run). */
  private async verifyAffected(): Promise<string | undefined> {
    const root = process.cwd();
    const files = await changedFiles(root);
    const a = files.length ? await affected(root, files) : undefined;
    if (!a?.test) return undefined;
    // Through the shell tool, so the approval mode, permission rules and the sandbox apply as to the agent's own commands.
    const r = await this.tools.call('shell', {command: a.test, timeout_ms: Math.min(60, this.config.shellMaxMinutes || 60) * 60_000});
    if (r.ok) return undefined;
    const out = r.text.trim();
    const digest = formatDigest(digestLog(out), out.split('\n').length);
    return `The tests for what this request changed failed (${a.system}: ${a.targets.slice(0, 8).join(', ')}${a.targets.length > 8 ? ', …' : ''}; \`${a.test}\`):\n${digest ?? out.split('\n').slice(-60).join('\n')}\nFix them before you finish, or if a failure isn't caused by this change, say so.`;
  }

  /** /pr digest: a plain-language summary of the branch for reviewers (risks, test evidence), from the utility model. */
  async prDigest(): Promise<string> {
    const root = process.cwd();
    const size = await branchSize(root);
    const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 30_000}).catch(() => undefined))?.stdout ?? '';
    const diff = (await git('diff', '--no-color', size ? (await git('merge-base', 'HEAD', size.base)).trim() : 'HEAD')).slice(0, 80_000);
    if (!diff.trim()) throw new Error('nothing changed on this branch');
    const tests = (this.engine?.transcript.messages ?? [])
      .flatMap((m) => m.tools ?? [])
      .filter((t) => t.label === 'Shell' && isTestCommand(t.summary))
      .slice(-3)
      .map((t) => `${t.summary} → ${t.ok ? 'passed' : 'failed'}\n${t.result.split('\n').slice(-8).join('\n')}`);
    const ref = resolveUtilityModel(this.config.compactionModel, this.config);
    if (!ref) throw new Error('no model available for the digest');
    const system = 'You write the description a human reviewer reads before a code review. Plain language, short. No marketing, no praise.';
    const prompt = `The change (git diff against its base):\n${diff}\n\nTest runs in the conversation that made it:\n${tests.join('\n\n') || '(none)'}\n\nWrite: 1) What changed and why, in 2-4 sentences. 2) Where to look closely: the risky parts, with file names. 3) Test evidence: what was run and the result, or "no tests were run". Use these three headings: ## Summary, ## Look closely at, ## Tests.`;
    const digest = (await completeWith(ref, this.config, system, prompt, {timeoutMs: 180_000})).trim();
    // Specs and plans committed with the change: the reviewer reads them next to the code.
    const docs = (await git('diff', '--name-only', size ? (await git('merge-base', 'HEAD', size.base)).trim() : 'HEAD'))
      .split('\n')
      .filter((f) => /^\.rein\/(specs|plans)\//.test(f));
    return docs.length ? `${digest}\n\n${specSection(docs)}` : digest;
  }

  /** /cost's budget lines: each cap in force and how much of it is used. */
  private budgetLines(): string[] {
    const b = effectiveBudget(this.config.budget);
    const s = this.spend();
    const line = (what: string, spent: number | undefined, cap: number | undefined) => (cap === undefined ? [] : [`  ${what.padEnd(18)} ${spent === undefined ? '—' : formatUsd(spent)} of ${formatUsd(cap)}`]);
    const lines = [...line('request budget', s?.request, b.requestUsd), ...line('goal budget', s?.goal, b.goalUsd), ...line('conversation budget', s?.conversation, b.conversationUsd)];
    return lines.length ? ['Budgets (config budget, or a lower one in .rein/settings.json):', ...lines] : [];
  }

  /** /cost: what this conversation, the latest request and the goal cost at API list prices. */
  costReport(): string {
    const t = this.engine?.sessionTokens ?? {uncached: 0, cached: 0, output: 0};
    if (t.usd === undefined) {
      const m = this.engine?.currentRef();
      return `No price for ${m ? `${m.provider}:${m.model}` : 'this model'} yet, so only tokens are counted. Add one under "prices" in ~/.rein/config.json.`;
    }
    const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
    const goal = this.goals.goal;
    return [
      'At API list prices (a subscription isn\'t billed per token; this is what the same tokens would cost on the API):',
      `  this conversation  ${formatUsd(t.usd)}  (uncached ${k(t.uncached)} · cached ${k(t.cached)} · received ${k(t.output)})`,
      `  latest request     ${formatUsd(Math.max(0, t.usd - this.requestStartUsd))}`,
      ...(goal?.startUsd !== undefined ? [`  goal so far        ${formatUsd(Math.max(0, t.usd - goal.startUsd))}  (${goal.status})`] : []),
      'Includes subagents and helper calls (compaction, decisions, the advisor).',
      ...this.budgetLines(),
    ].join('\n');
  }

  /** Set the scope (a folder inside the project; undefined or "off" clears it). Returns it, absolute. */
  setScope(dir: string | undefined): string | undefined {
    if (!dir || dir === 'off') {
      this.scope = undefined;
    } else {
      const abs = path.resolve(process.cwd(), dir);
      const rel = path.relative(process.cwd(), abs);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`--scope ${dir}: must be a folder inside the project`);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`--scope ${dir}: not a folder`);
      this.scope = rel ? realpathSync(abs) : undefined;
    }
    this.engine?.refreshTools(); // the system prompt names the scope and loads its instructions
    return this.scope;
  }
  engine!: Engine;
  /** Last auto-routing decision, for the status line / debugging. */
  lastDecision: string | undefined;
  auto: AutoRouter = makeAutoRouter({config: () => this.config, onDecision: (d) => (this.lastDecision = d)});
  compact = (t: Transcript, _reason: CompactReason, opts?: Parameters<typeof compactTranscript>[2]): Promise<CompactResult> => {
    // The summary may not keep subfolder instructions word for word: deliver them again as needed.
    this.tools.deliveredInstructions.clear();
    return compactTranscript(t, this.config, opts);
  };

  /**
   * SessionStart hooks: their output becomes context for the first message. Also run right after
   * the user trusts the project's hooks (untrusted ones were skipped at startup).
   */
  async sessionStartHooks(source: 'startup' | 'resume', projectOnly = false): Promise<void> {
    if (!hasHooks('SessionStart', process.cwd(), {projectOnly})) return;
    const out = await runHooks('SessionStart', process.cwd(), {source}, {projectOnly}).catch(() => undefined);
    if (out?.context) this.sessionContext = [this.sessionContext, out.context].filter(Boolean).join('\n');
  }

  /** Plan mode (/plan, Shift+Tab, --permission-mode plan): read-only until a plan is approved. */
  private plan = false;
  /** planReview already ran in this planning session (reset when plan mode turns on). */
  private planReviewed = false;
  get planMode(): boolean {
    return this.plan;
  }
  set planMode(on: boolean) {
    if (on && !this.plan) this.planReviewed = false;
    this.plan = on;
  }
  /** Spec mode (/spec): the spec being written; plan mode's blocking applies until its tasks are approved. */
  specMode: string | undefined;
  /** Set by the UI: shows a presented plan and resolves with the user's decision. */
  planPresenter: ((plan: PresentedPlan) => Promise<PlanDecision | undefined>) | undefined;
  /** Set by the UI: shows the agent's questions and resolves with the answers (undefined = dismissed). */
  askPresenter: ((questions: AskQuestion[]) => Promise<AskAnswer[] | undefined>) | undefined;
  /** Rules for this run only (headless --allowedTools / --disallowedTools). */
  extraRules: {allow: string[]; deny: string[]} = {allow: [], deny: []};
  /** Set by the UI: shows the approval prompt for a file-changing tool call. */
  approver: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;
  readonly tools = new ToolHost({
    root: process.cwd(),
    approve: (req) => (this.approver ? this.approver(req) : Promise.resolve('deny')),
    extraRules: () => this.extraRules,
    planMode: () => this.planMode,
    mode: () => this.config.toolApproval,
    shellMaxMs: () => this.config.shellMaxMinutes * 60_000,
    sandbox: () => this.config.sandbox ?? 'write',
    scratch: () => this.engine?.scratch,
    sessionId: () => this.engine?.transcript.id,
    judge: (req) => this.judgeChange(req),
    readOnlyJudge: (command) => this.judgeReadOnly(command),
    configDirs: () => [...(this.config?.additionalDirectories ?? []), ...workspaceDirs(this.workspace)],
    workspaceRepos: () => (this.workspace?.repos ?? []).filter((r) => r.present).map((r) => ({name: r.name, path: r.path})),
    scope: () => this.scope,
    secretScan: () => this.config.secretScan ?? 'off',
    depCheck: () => this.config.depCheck ?? 'off',
    buildTimes: () => this.config.buildTimeWarnings !== false,
    policy: () => loadPolicy(process.cwd(), reinConfigDir()),
    injectionScan: () => this.config.injectionScan === true,
    exfilGuard: () => this.config.exfilGuard === true,
    checkpoint: (file) => this.checkpoints.snapshot(this.currentTurn(), file),
    experiments: () => activeExperiments(this.config),
    contextId: () => this.engine?.contextId(),
    untrusted: (origin) => origin.agentId !== undefined && !!this.agents.get(origin.agentId)?.untrusted,
    mask: (text) => this.vault.mask(text),
    steerShell: () => this.config.steerShell !== false,
    diagnostics: {
      before: (files, root) => this.lsp.before(files, root),
      after: (snapshot) => this.lsp.after(snapshot as Before),
      read: (file, root) => this.lsp.prewarm(file, root),
      shell: (root) => this.lsp.resync(root),
    },
    isolate: (origin, writes) => this.isolate(origin, writes),
  });

  /** Subagents' private worktrees (see agents/worktrees.ts). */
  readonly worktrees = new Worktrees(process.cwd(), () => this.engine?.transcript.id);

  /**
   * Whether a subagent's call runs in its own worktree: once it has one, always; otherwise it gets
   * one on its first change when other work is going on (it runs in the background, or another
   * subagent is running). A lone foreground subagent works in place, as before.
   */
  private async isolate(origin: Origin, writes: boolean): Promise<{root: string; writable: string[]} | undefined> {
    if (origin.agentId === undefined) return undefined;
    const have = this.worktrees.get(origin.agentId);
    if (have) return have;
    if (!writes || (this.config.worktrees ?? 'auto') === 'off') return undefined;
    const agent = this.agents.get(origin.agentId);
    if (!agent) return undefined;
    const others = this.agents.running().some((a) => a.id !== agent.id);
    if (!agent.background && !others) return undefined;
    return this.worktrees.ensure(agent.id);
  }

  /** MCP servers (project .mcp.json, ~/.rein/mcp.json, Claude Code's ~/.claude.json). */
  readonly mcp = new McpManager(process.cwd());

  /** The secrets vault (vault/vault.ts): values for shell commands the model never sees. */
  readonly vault = new Vault();

  /**
   * The remote page (remote/server.ts) and the TUI meet here: `engine` events as the chat consumes
   * them, `input` text sent from the page, `approval` when the one shown changes.
   */
  readonly remoteBus = new EventEmitter();
  /** The approval on screen now, answerable from the remote page too (first answer wins). */
  remoteApproval: {id: number; req: ApprovalRequest; resolve(d: ApprovalDecision): void} | undefined;
  remote: RemoteServer | undefined;
  /** Issue trackers handing work to Rein (trackers/watcher.ts); started by the interactive UI. */
  /** Your pet from the ChatGPT and Codex apps (pets/index.ts). */
  readonly pets = new Pets(() => this.config.pet !== 'off');

  /**
   * Find your pet, and when the pets plugin is installed, give the agent its tools (so the pets
   * skills work with any model). Background, after startup: it starts a codex app-server.
   */
  /**
   * Load the code of the marketplace items you installed (extensions/index.ts): their commands,
   * tools, sidebar sections, status segments and themes. At startup and after an install.
   */
  async loadExtensions(): Promise<{loaded: string[]; failed: {id: string; error: string}[]}> {
    const r = await extensions.loadAll({
      cwd: () => process.cwd(),
      config: () => this.config as unknown as Record<string, unknown>,
      registerTool: (item, t) => {
        this.tools.register({
          name: t.name,
          label: t.label,
          description: `${t.description}\n(From the marketplace item ${item}.)`,
          inputSchema: t.inputSchema,
          mutating: !!t.mutating,
          summarize: (args: any) => (t.summarize ? t.summarize(args) : ''),
          run: async (ctx, args) => {
            const res = await t.run(args, {cwd: ctx.root});
            return {ok: !!res?.ok, text: String(res?.text ?? '')};
          },
        });
      },
      exec: async (command, args, opts) => {
        const r = await run(command, args, {cwd: opts?.cwd ?? process.cwd(), timeoutMs: opts?.timeoutMs ?? 120_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
        return {code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr};
      },
      ripgrep: async () => (await ripgrep()) ?? undefined,
      workspace: () => {
        const w = this.workspace;
        return w ? {root: w.root, repos: w.repos.map((x) => ({name: x.name, path: x.path, present: x.present, ...(x.role ? {role: x.role} : {})}))} : undefined;
      },
    });
    if (r.loaded.length) this.engine?.refreshTools();
    return r;
  }

  async loadPets(): Promise<void> {
    await this.pets.refresh();
    const hasSkills = loadSkills().some((s) => s.plugin === 'work-pets' || s.name.startsWith('work-pets:'));
    if (!hasSkills || this.petToolsLoaded) return;
    const tools = await this.pets.appTools();
    if (!tools.length) return;
    this.petToolsLoaded = true;
    this.tools.register(...petTools(this.pets, tools));
    this.engine?.refreshTools();
  }
  private petToolsLoaded = false;

  readonly trackers = new TrackerWatcher({
    trackers: () => this.config.trackers ?? [],
    pollMinutes: () => this.config.trackerPollMinutes ?? 2,
    make: (cfg) => makeTracker(cfg, this.vault.env()),
    work: (issue, _tracker, cfg) => this.issueSession(issue, cfg),
    log: (text, kind) => {
      this.trackerLog?.(text, kind);
      if (/: done|failed:/.test(text)) this.notifyRemote('Rein finished an issue', text.replace(/^⇢\s*/, '')); // your phone too
    },
  });
  /** Where tracker news goes (the UI's transcript). */
  trackerLog: ((text: string, kind?: 'info' | 'error') => void) | undefined;

  /** An issue from a tracker: an untrusted background subagent on its own branch; resolves with its report. */
  private async issueSession(issue: Issue, cfg: TrackerConfig): Promise<{report: string; branch: string}> {
    const branch = `rein/${issue.ref.replace(/^#/, 'issue-').replace(/[^\w.-]+/g, '-').toLowerCase()}`;
    const wt = await this.worktrees.createBranch(branch);
    if (!wt) throw new Error("this project isn't a git repository, so there's no branch to work on");
    const {agent, done} = this.agents.spawn({
      task: issueTask(issue, cfg.kind, branch),
      model: cfg.model ?? this.config.subagentModel ?? 'auto',
      mode: 'new',
      name: `issue ${issue.ref}`,
      background: true,
      untrusted: true,
    });
    this.worktrees.adopt(agent.id, wt); // before its first tool call: everything it does happens on the branch
    agent.collected = true; // its report goes to the issue, not into your conversation
    const finished = await done;
    // The branch note is for agents (it names a local path): the issue comment says the branch itself.
    const report = (finished.output || '(no report)').replace(/\n*\[Its work is on the branch [^\]]*\]\s*$/, '').trim();
    return {report: report || '(no report)', branch};
  }

  /**
   * /bestof: the task on the best available Claude model and the best Codex model at once, each in
   * its own worktree; the result that passes the tests is merged into the project.
   */
  async bestOf(task: string, testCommand: string, log: (text: string) => void): Promise<string> {
    const avail = catalog.available(this.config.maxUsedPct);
    const best = (p: 'claude' | 'codex') => avail.filter((m) => m.provider === p).sort((a, b) => b.tier - a.tier)[0];
    const pair = [best('claude'), best('codex')];
    if (!pair[0] || !pair[1]) throw new Error(`/bestof needs a Claude and a Codex account with room to work (${!pair[0] ? 'no Claude model is available' : 'no Codex model is available'}).`);
    if (!(await repoTop(process.cwd()))) throw new Error("/bestof needs a git repository: each attempt runs in its own worktree.");
    const contenders = pair.map((m) => {
      const ref = toRef(m!);
      return {label: ref.provider === 'claude' ? 'Claude' : 'Codex', model: `${ref.provider}:${ref.model}`};
    });
    const result = await runBestOf(
      {
        spawn: (t, model, name) => {
          const {agent, done} = this.agents.spawn({task: t, model, mode: 'new', name, background: true});
          agent.collected = true; // the outcome is reported by /bestof, not dropped into your conversation
          return {id: agent.id, done: done.then((a) => ({status: a.status, output: a.output ?? ''}))};
        },
        hold: (id) => this.worktrees.hold(id),
        result: (id) => this.worktrees.heldResult(id),
        test: async (command, root) => {
          const sh = shellFor(command);
          const r = await run(sh.file, sh.args, {cwd: root, timeoutMs: (this.config.shellMaxMinutes || 120) * 60_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
          return {ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim()};
        },
        release: async (id, keep) => {
          const r = await this.worktrees.release(id, keep);
          if (r?.kept) this.tools.addDirs([r.kept]);
          return r && keep ? mergeNote(r) : undefined;
        },
        log,
      },
      task,
      contenders,
      testCommand,
    );
    return formatBestOf(result, testCommand);
  }

  /** Tell your phone (config notifyUrl): approvals waiting, work finished, issues done. */
  notifyRemote(title: string, message: string): void {
    void sendWebhook(this.config.notifyUrl, title, this.vault.mask(message));
  }

  /** Built-in code intelligence: language servers Rein runs itself (lsp/manager.ts). */
  readonly lsp = new LspManager({config: () => this.config, scope: () => this.scope});

  /** File checkpoints for /rewind, per conversation (Rein's own file changes, ignored files too). */
  readonly checkpoints = new Checkpoints(() => this.engine?.transcript.id ?? 'none');
  /** Whole-tree snapshots for /rewind (covers shell-made changes); see snapshots.ts. */
  readonly snapshots = new WorkspaceSnapshots(process.cwd(), () => this.engine?.transcript.id ?? 'none', () => workspaceDirs(this.workspace));

  /** Index of the user message the agent is working on (checkpoints are grouped by it). */
  currentTurn(): number {
    const m = this.engine?.transcript.messages ?? [];
    for (let i = m.length - 1; i >= 0; i--) if (m[i]!.role === 'user' && !m[i]!.synthetic) return i;
    return 0;
  }

  /**
   * `auto` approvals: one decision-model call (Jev or the cheap LLM) with minimal state — the user's
   * latest request, the action and a clipped preview. Allows only confident "clearly requested and
   * safe" verdicts; everything else is shown to the user.
   */
  /** Plan mode: is a shell command purely a lookup (changes nothing on disk, in git, packages or services)? */
  private async judgeReadOnly(command: string): Promise<{readOnly: boolean; note: string}> {
    const decision = await decide(this.config, {shell_command: command.slice(0, 2000)}, {
      read_only: {
        type: 'noul',
        instructions:
          'Does this shell command only READ — inspect files, print information, query package managers or the system — without changing anything? Any write counts as a change: creating, modifying or deleting files (including > redirects and tee), installing/upgrading/removing packages, git commits/checkouts/resets, starting or stopping services, network uploads.',
        criteria: {true: 'only reads / prints information', false: 'changes something, or unclear'},
      },
    });
    const a = decision.answers.read_only;
    const p = a?.type === 'noul' ? a.noul : 0;
    return {readOnly: p >= READ_ONLY_MIN, note: `${p.toFixed(2)} via ${decision.backend}`};
  }

  private async judgeChange(req: ApprovalRequest): Promise<{allow: boolean; note: string}> {
    const lastUser = [...(this.engine?.transcript.messages ?? [])].reverse().find((m) => m.role === 'user' && !m.synthetic);
    const state = {
      user_request: headTail(lastUser?.text ?? ''),
      action: `${req.tool.label} ${req.summary}`,
      change_preview: req.preview.slice(0, 1500),
    };
    const decision = await decide(this.config, state, {
      allow: {
        type: 'noul',
        instructions: req.outside?.length
          ? `The agent wants to ${req.tool.mutating ? 'change' : 'read'} ${req.outside.join(', ')}, which is outside the project folder. Is that clearly something the user asked for (directly or as a necessary step) and harmless — not credentials, secrets or private data unrelated to the task?`
          : req.tool.name === 'shell'
            ? 'Is this shell command clearly something the user asked for (directly or as a necessary step, e.g. running tests/builds or a dev server they want), and safe — no deleting files, force-pushing, installing system software, touching credentials, or contacting unexpected hosts?'
            : 'Is this file change clearly something the user asked for (directly or as a necessary step), and safe — not deleting or overwriting unrelated work?',
        criteria: {true: 'clearly requested and safe', false: 'not requested, unclear, or risky'},
      },
    });
    const a = decision.answers.allow;
    const p = a?.type === 'noul' ? a.noul : 0;
    return {allow: p >= AUTO_APPROVE_MIN, note: `${p.toFixed(2)} via ${decision.backend}`};
  }

  /** `resume`: a session id to load directly; `true`/`false` start fresh (the UI shows the picker for `true`). */
  /** Subagents spawned by the main agent's `agent` tool. */
  readonly agents: SubagentManager = new SubagentManager({
    limit: () => this.config.subagentLimit,
    resolve: async () => {
      throw new Error('unused');
    },
    open: (agent, tools) => this.openSubagent(agent, tools),
    bind: (agent) => {
      const origin = {agentId: agent.id, name: agent.name};
      const only = agent.definition?.tools;
      const permitted = (name: string) => !only || only.includes(name) || only.some((t) => t.startsWith('mcp__') && name.startsWith(t));
      let closeSocket: (() => void) | undefined;
      const host = this.tools;
      return {
        binding: {
          // Fork-mode histories reference agent/agent_result, so forks still see their definitions.
          // A definition's `tools` list narrows what it sees and may call (MCP servers by prefix).
          get tools() {
            return host.specs({subagent: true, includeMainOnly: agent.mode === 'fork'}).filter((t) => permitted(t.name));
          },
          call: (name, args) => (permitted(name) ? host.callInOrder(name, args, origin) : Promise.resolve({ok: false, text: `${name} isn't available to the ${agent.definition?.name} subagent`})),
          listen: async () => {
            const l = await host.listenFor(origin);
            closeSocket = l.close;
            return l.socket;
          },
          proxy: mcpProxyCommand(),
          allowed: host.specs({subagent: true}).map((t) => t.name).filter(permitted),
        },
        close: () => closeSocket?.(),
      };
    },
    judge: (agent) => this.judgeCompletion(agent),
    advise: async (agent, verdict) => {
      if (!advisorRef(this.config)) return undefined;
      const question = `A completion check says my task isn't finished (${verdict.note}). What is most likely missing, and what should I do next? Be brief and specific.`;
      const res = await this.tools.call('advisor', {question}, {agentId: agent.id, name: agent.name});
      return res.ok ? res.text : undefined;
    },
    onActivity: (agentId, fn) => {
      const h = (a: ToolActivity) => {
        if (a.origin?.agentId === agentId) fn(a);
      };
      this.tools.on('activity', h);
      return () => void this.tools.off('activity', h);
    },
    finished: (agent) => this.subagentFinished(agent),
    settle: async (agent) => {
      const wtRoot = this.worktrees.get(agent.id)?.root;
      const r = await this.worktrees.settle(agent.id);
      if (wtRoot) void this.lsp.stopRoot(wtRoot); // its language servers go with the worktree
      if (!r) return undefined;
      if (r.kept && !r.branch) this.tools.addDirs([r.kept]); // the main agent merges the conflicting files from there
      return mergeNote(r);
    },
    killShells: (agentId) => {
      for (const s of this.tools.shells.running()) if (s.origin?.agentId === agentId) this.tools.shells.kill(s.id);
    },
  });

  private folded = new Map<number, TokenCount>();
  private stopUsageRefresh: () => void = () => {};

  /** `/goal`: keeps the agent on an objective until the decision model accepts the evidence. */
  readonly goals = new GoalManager({
    maxRounds: () => this.config.goalMaxRounds,
    transcript: () => this.engine?.transcript,
    save: () => {
      if (this.engine) void saveTranscript(this.engine.transcript).catch(() => {});
    },
    decide: (state, questions) => decide(this.config, state, questions),
    advise: async (question) => {
      const ref = advisorRef(this.config);
      if (!ref) return undefined;
      const res = await this.tools.call('advisor', {question});
      return res.ok ? res.text : undefined;
    },
    investigate: async (task) => {
      const {done} = this.agents.spawn({task, mode: 'new', model: 'auto', name: 'goal-unblocker'});
      const a = await done;
      return a.output || `(no report; ${a.status})`;
    },
  });

  private async openSubagent(agent: Subagent, tools: ToolBinding) {
    if (agent.mode === 'fork') {
      // A fork continues the parent's native session, so it runs on the parent's account.
      const session = catalog.track(await this.engine.openFork(tools));
      const ref = this.engine.current!.ref;
      return {session, ref, accountId: this.engine.current!.accountId, label: catalog.get(ref)?.label ?? ref.model};
    }
    // `inherit` (a definition's model): the main agent's current model, else routed like auto.
    let ref: ModelRef | undefined = agent.requested === 'inherit' ? this.engine.current?.ref : undefined;
    if (!ref && (agent.requested === 'auto' || agent.requested === 'inherit')) {
      const t = newTranscript();
      t.messages.push({role: 'user', text: agent.task, at: Date.now()});
      ref = (await this.auto(agent.task, t, undefined, new Set())).ref;
    } else if (!ref) {
      ref = parseRef(agent.requested);
      if (!ref || !catalog.get(ref)) throw new Error(`model ${agent.requested} isn't available; use one from the tool description or "auto"`);
    }
    const blocked = modelBlocked(loadPolicy(process.cwd(), reinConfigDir()), ref);
    if (blocked) throw new Error(`${blocked}; give the subagent a model the policy allows`);
    const account = catalog.healthyAccounts(ref, this.config.maxUsedPct)[0];
    if (!account) throw new Error(`no healthy account for ${ref.model}`);
    const role = agent.definition ? `\n\n# Your role: ${agent.definition.name}\n${agent.definition.prompt}` : '';
    const prompt = `${await systemPrompt({tools: true, scratch: this.engine.scratch, provider: ref.provider})}\n\n${SUBAGENT_PROMPT(agent.name)}${role}`;
    const session = catalog.track(await adapters[ref.provider].openSession({account, model: ref.model, systemPrompt: prompt, tools}));
    return {session, ref, accountId: account.id, label: catalog.get(ref)?.label ?? ref.model};
  }

  /**
   * Carry selection: the compaction model sees a one-line index of the tool calls (never their
   * full results) and returns the ones a new session needs to continue.
   */
  private async selectCarry({index, request, budgetTokens}: {index: string; request: string; budgetTokens: number}): Promise<number[]> {
    const ref = resolveUtilityModel(this.config.compactionModel, this.config);
    if (!ref) throw new Error('no compaction model available');
    const reply = await completeWith(
      ref,
      this.config,
      `You decide what context an AI coding agent keeps when its conversation moves to a new session.
Keep the tool results its next steps depend on: the latest contents of files it is working on (only the most recent read/edit of each file), recent errors and test/build output, command results and search results it is still using.
Drop superseded reads of the same file, routine listings, and output that no longer matters. Reply with only a JSON array of # indices, most important first.`,
      `The user's latest message:\n${request.slice(0, 2000)}\n\nTool calls so far (#index Tool(args) status · size · first line of the result):\n${index}\n\nThe full results you pick must fit in about ${budgetTokens} tokens. JSON array of indices:`,
      {timeoutMs: 45_000, fast: true},
    );
    return parseIndices(reply);
  }

  /** SessionStart hook context, added to the first message of the session. */
  private sessionContext: string | undefined;

  /** `!command` runs typed by the user since the last message: they go along with the next one. */
  private userShells: string[] = [];
  noteUserShell(command: string, exit: string, output: string): void {
    this.userShells.push(`<user_shell command=${JSON.stringify(command)} status=${JSON.stringify(exit)}>\n${output.slice(-10_000)}\n</user_shell>`);
  }

  /** The connected editor (Claude Code IDE extension protocol), if any. */
  ide: IdeConnection | undefined;
  /** Called when the editor connects, disconnects, or its selection changes (UI refresh). */
  onIdeChange?: () => void;
  onIdeMention?: (m: {filePath: string; lineStart?: number; lineEnd?: number}) => void;

  /** Connect to the editor whose workspace holds this project; returns what happened. */
  async connectIde(): Promise<string> {
    const lock = findIdes()[0];
    if (!lock) return "No editor found for this project. Install the Claude Code extension in VS Code, Cursor, Windsurf or a JetBrains IDE and open this folder there.";
    await this.ide?.close();
    this.ide = undefined;
    const conn = await IdeConnection.connect(lock);
    this.ide = conn;
    conn.on('selection', () => this.onIdeChange?.());
    conn.on('mention', (m) => this.onIdeMention?.(m));
    conn.on('close', () => {
      if (this.ide === conn) this.ide = undefined;
      this.onIdeChange?.();
    });
    this.onIdeChange?.();
    return `Connected to ${lock.ideName}: your selection goes with your messages, file changes open as diffs there, and the agent can read its diagnostics.`;
  }

  private async beforePrompt(text: string): Promise<{block?: string; context?: string}> {
    const root = process.cwd();
    // A message from the user (not Rein's own follow-up) ends an escalation: routing is normal again.
    if (!/^<(code_check|stop_hook)>/.test(text)) {
      this.requestStartUsd = this.engine?.sessionTokens.usd ?? 0;
      this.sastChecked = false;
      this.contractsChecked = false;
      this.migrationsChecked = false;
      this.affectedChecked = false;
      this.sizeChecked = false;
      this.budgetStop = undefined;
      this.tools.watchdog.reset();
      this.tools.repeats.reset();
      this.escalation = undefined;
      this.verifyPasses = 0;
      this.verifiedAt = undefined;
      this.reviewed = false;
      this.keptGoing = 0;
    }
    // Snapshot the project before this message runs, so /rewind can undo everything it causes.
    if (this.engine) await this.snapshots.snapshot(this.engine.transcript.messages.length);
    const session_id = this.engine?.transcript.id;
    const out = hasHooks('UserPromptSubmit', root) ? await runHooks('UserPromptSubmit', root, {session_id, prompt: text}) : {errors: []};
    // What you have selected in the editor right now goes along (like Claude Code's "⧉ selected").
    const sel = this.ide?.selection;
    const selection = sel
      ? `<ide_selection file="${path.relative(root, sel.filePath) || sel.filePath}" lines="${sel.startLine}-${sel.endLine}">\n${sel.text.slice(0, 20_000)}\n</ide_selection>\nThe user has this selected in their editor; it may or may not be what the message is about.`
      : undefined;
    const shells = this.userShells.length ? `${this.userShells.join('\n')}\nThe user ran ${this.userShells.length > 1 ? 'these commands' : 'this command'} themselves (with !) before this message.` : undefined;
    const context = [this.sessionContext, out.context, shells, selection, this.planMode ? (this.specMode ? SPEC_MODE_CONTEXT(this.specMode) : PLAN_MODE_CONTEXT) : undefined, this.planMode && activeExperiments(this.config).includes('adr-check') ? adrContext(process.cwd()) : undefined].filter(Boolean).join('\n');
    if (!out.block) this.userShells = [];
    if (!out.block) this.sessionContext = undefined;
    return {block: out.block, context: context || undefined};
  }

  /**
   * Stop hooks after a reply: exit 2 / decision "block" keeps the agent going with the reason as
   * its next instruction. `active` is true while continuing because of a Stop hook (as in Claude Code).
   */
  /**
   * The agent finished its turn: should it keep going? A Stop hook may say so (Claude Code
   * compatible); otherwise the code check may (problems the turn's changes left, from the
   * language servers, once per turn).
   */
  async stopHook(active: boolean): Promise<{reason: string; kind: 'hook' | 'diagnostics'} | undefined> {
    const root = process.cwd();
    if (hasHooks('Stop', root)) {
      const out = await runHooks('Stop', root, {session_id: this.engine?.transcript.id, stop_hook_active: active});
      if (out.block) return {reason: out.block, kind: 'hook'};
    }
    // cross-review: once per request, a strong model from the other provider reviews the change against
    // the request; what it finds goes back to the agent (a second pair of eyes no single-vendor CLI has).
    if (!active && activeExperiments(this.config).includes('cross-review') && !this.reviewed && this.engine && this.checkpoints.changedSince(this.currentTurn()).length) {
      this.reviewed = true;
      const findings = await this.crossReview().catch(() => undefined);
      if (findings) return {kind: 'hook', reason: findings};
    }
    // self-review: the same model, in a fresh call without this conversation, reviews the change against the request.
    if (!active && activeExperiments(this.config).includes('self-review') && !this.reviewed && this.engine && this.checkpoints.changedSince(this.currentTurn()).length) {
      this.reviewed = true;
      const self = this.engine.currentRef();
      const findings = self ? await this.crossReview(self, 'A fresh review of your change (the same model, without this conversation)').catch(() => undefined) : undefined;
      if (findings) return {kind: 'hook', reason: findings};
    }
    // verify-requirements: once per request, before the agent stops after changing files, it runs its
    // change against every requirement in the request (hard tasks fail on the edge case it never tried).
    // Once more if that pass changed the code: its fixes were never run against the requirements.
    if (activeExperiments(this.config).includes('verify-requirements') && this.engine) {
      const again = active && this.verifiedAt !== undefined && this.verifyPasses < VERIFY_MAX;
      if ((!active && !this.verifyPasses) || again) {
        const since = again ? this.verifiedAt! : this.currentTurn();
        if (await this.changedSince(since)) {
          this.verifyPasses++;
          this.verifiedAt = this.engine.transcript.messages.length; // the index the hook's message gets
          return {
            kind: 'hook',
            reason: again
              ? "You changed the code while checking it. Run your requirement checks again against the final code (the same quick scripts or tests), fix whatever fails, then run the project's tests. If everything passes, reply with a short confirmation and stop."
              : "Before you finish, check your change against the user's request line by line. For every concrete requirement (each behaviour, error case and its message, edge case, name, value and attribute), run it: one quick script or test that exercises several requirements at once is fine, rereading the code is not. Fix whatever fails or is missing, then run the project's tests. If everything already passes, reply with a short confirmation and stop: don't redo work.",
          };
        }
        this.verifiedAt = undefined;
      }
    }
    // escalate: the check already reported these and the agent's follow-up turn left them: a stronger
    // model takes the task over (for the rest of it; the next message from the user routes normally).
    if (active && activeExperiments(this.config).includes('escalate') && !this.escalation) {
      const left = await this.lsp.stillThere().catch(() => [] as string[]);
      const to = left.length ? this.strongerModel() : undefined;
      if (to) {
        this.escalation = to;
        return {
          kind: 'diagnostics',
          reason: `These problems from the last check are still there after another attempt:\n${left.slice(0, 10).join('\n')}\nA stronger model is taking over this task: fix them, or if one should stay, say why.`,
        };
      }
    }
    const problems = await this.lsp.turnEnd().catch(() => undefined);
    if (problems) return {reason: problems, kind: 'diagnostics'};
    // sast: Semgrep on the files this request changed, once per request (findings on added lines only).
    if (this.config.sast === 'semgrep' && !this.sastChecked && this.engine) {
      const since = this.currentTurn();
      const files = this.checkpoints.changedSince(since).filter((f) => existsSync(f));
      if (files.length) {
        this.sastChecked = true;
        const found = await sastCheck(files.map((file) => ({file, before: this.checkpoints.before(since, file)})), process.cwd(), this.config.sastConfig || 'auto').catch(() => undefined);
        if (found) return {reason: found, kind: 'diagnostics'};
      }
    }
    // contract-check: breaking changes this request made to API contracts, once per request.
    if (activeExperiments(this.config).includes('contract-check') && !this.contractsChecked && this.engine) {
      const since = this.currentTurn();
      const files = this.checkpoints.changedSince(since);
      const found = files
        .map((f) => {
          const before = this.checkpoints.before(since, f); // null: it didn't exist; undefined: not known
          return before === undefined ? undefined : classify(path.relative(process.cwd(), f).split(path.sep).join('/'), before ?? undefined, existsSync(f) ? readFileSync(f, 'utf8') : undefined);
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      if (found.length) {
        this.contractsChecked = true;
        const note = contractNote(found);
        if (note) return {reason: note, kind: 'diagnostics'};
      }
    }
    // migration-check: the request's migrations that lock, need a backfill, can't be undone or break running code.
    if (activeExperiments(this.config).includes('migration-check') && !this.migrationsChecked && this.engine) {
      const root = process.cwd();
      const files = this.checkpoints.changedSince(this.currentTurn()).filter((f) => existsSync(f) && isMigration(path.relative(root, f)));
      if (files.length) {
        this.migrationsChecked = true;
        const note = migrationNote(files.flatMap((f) => lintMigration(root, path.relative(root, f), readFileSync(f, 'utf8'))));
        if (note) return {reason: note, kind: 'diagnostics'};
      }
    }
    // prMaxLines: the branch grew past the size reviewers can take; say so to you (not the agent), once per request.
    if (!this.sizeChecked && (this.config.prMaxLines ?? 0) > 0 && this.engine && this.checkpoints.changedSince(this.currentTurn()).length) {
      this.sizeChecked = true;
      const size = await branchSize(process.cwd()).catch(() => undefined);
      if (size && size.lines > this.config.prMaxLines)
        this.uiLog(`This branch now changes ${size.lines.toLocaleString()} lines (+${size.added} −${size.removed} vs ${size.base}), over prMaxLines (${this.config.prMaxLines}). Smaller PRs get reviewed faster: /pr split asks the agent to split it into a stack.`);
    }
    // verify-affected: in an Nx/Turborepo/Bazel/Pants workspace, the tests for what this request changed, once.
    if (activeExperiments(this.config).includes('verify-affected') && !this.affectedChecked && this.engine && this.checkpoints.changedSince(this.currentTurn()).length) {
      this.affectedChecked = true;
      const failed = await this.verifyAffected().catch(() => undefined);
      if (failed) return {reason: failed, kind: 'diagnostics'};
    }
    // keep-going: the agent ended its turn but its own reply says the work isn't done ("I've only
    // partly done this"), and it isn't waiting on the user: send it back, a few times per request.
    // Models stop like this on long tasks, more often right after a compaction.
    if (activeExperiments(this.config).includes('keep-going') && this.keptGoing < KEEP_GOING_MAX && this.engine) {
      const unfinished = await this.stoppedEarly().catch(() => false);
      if (unfinished) {
        this.keptGoing++;
        return {
          kind: 'hook',
          reason: "Your last message says the task isn't finished, and nothing in it needs the user's input. Keep going: carry on from where you stopped and finish the whole request. Only stop when it's done, or when you genuinely need the user to decide something.",
        };
      }
    }
    return undefined;
  }

  /** keep-going: rounds used for the current request. */
  private keptGoing = 0;

  /** keep-going: does the agent's final reply admit it stopped partway, without needing the user? */
  private async stoppedEarly(): Promise<boolean> {
    const messages = this.engine.transcript.messages;
    const reply = messages.at(-1)?.role === 'assistant' ? messages.at(-1)!.text : '';
    if (!reply.trim()) return false;
    const request = [...messages].reverse().find((m) => m.role === 'user' && !/^<(code_check|stop_hook)>/.test(m.text))?.text ?? '';
    const d = await decide(this.config, {request: headTail(request), final_reply: headTail(reply)}, {
      unfinished: {
        type: 'noul',
        instructions: "The assistant just ended its turn with final_reply. By its own account, did it stop before finishing the request (it says the work is partial, lists remaining or next steps it hasn't done, or says the code doesn't build or pass yet), while not needing anything from the user (no question for them, no decision only they can make, nothing it is blocked on)?",
        criteria: {true: 'stopped partway on its own, could have kept going', false: 'finished, or genuinely needs the user, or blocked'},
      },
    });
    const a = d.answers.unfinished;
    return a?.type === 'noul' ? a.noul >= 0.5 : false;
  }

  /** verify-requirements: checks sent for the current request, and the message index of the last one. */
  private verifyPasses = 0;
  private verifiedAt: number | undefined;

  /** Did files change since the message at `turn`: Rein's own edits, or anything else (shell) per the tree snapshot. */
  private async changedSince(turn: number): Promise<boolean> {
    if (this.checkpoints.changedSince(turn).length) return true;
    return (await this.snapshots.changedSince(turn).catch(() => [])).length > 0;
  }
  /** cross-review: the review already ran for the current request. */
  private reviewed = false;

  /** The other provider's strongest available model, for a review (undefined if none is signed in). */
  private reviewerFor(cur: ModelRef): ModelRef | undefined {
    const others = catalog.available(this.config.maxUsedPct).filter((m) => m.provider !== cur.provider);
    const best = others.sort((a, b) => b.tier - a.tier)[0];
    return best ? toRef(best) : undefined;
  }

  /**
   * planReview: a second model (the other provider's, or the advisor) critiques a plan or a spec's
   * design once per planning session, before the user sees it. Returns the message for the agent.
   */
  async reviewPlan(kind: 'plan' | 'design', text: string): Promise<string | undefined> {
    const mode = this.config.planReview ?? 'off';
    if (mode === 'off' || this.planReviewed || !this.engine) return undefined;
    const cur = this.engine.currentRef();
    const reviewer = mode === 'advisor' ? advisorRef(this.config) : cur && this.reviewerFor(cur);
    if (!reviewer) return undefined;
    this.planReviewed = true;
    const request = [...this.engine.transcript.messages].reverse().find((m) => m.role === 'user' && !/^<(code_check|stop_hook)>/.test(m.text))?.text ?? '';
    const system = `You review a software ${kind} before any code is written. Report only concrete problems: parts of the request it misses, steps that won't work or are in the wrong order, risks it doesn't handle, simpler approaches it overlooks, and verification that wouldn't prove it works. No praise, no rewriting it.`;
    const prompt = `The request:\n${request.slice(0, 20_000)}\n\nThe ${kind}:\n${text.slice(0, 40_000)}\n\nList each problem on one line, most important first. If there are none, reply exactly NONE.`;
    const reply = (await completeWith(reviewer, this.config, system, prompt, {timeoutMs: 240_000})).trim();
    if (!reply || /^none\b/i.test(reply)) return undefined;
    return `Before the user sees it, a second model (${reviewer.provider}:${reviewer.model}) reviewed your ${kind} and reported:\n${reply.slice(0, 6000)}\nCheck each point against the code. Fold in the ones that hold up, note in a line the ones that don't, then call ${kind === 'plan' ? 'present_plan' : 'present_spec'} again with the revised ${kind}.`;
  }

  /** cross-review: the reviewer's findings as a message for the agent, or undefined when it found nothing. */
  private async crossReview(by?: ModelRef, who?: string): Promise<string | undefined> {
    const cur = this.engine?.currentRef();
    const reviewer = by ?? (cur && this.reviewerFor(cur));
    if (!reviewer || !this.engine) return undefined;
    const root = process.cwd();
    const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 20_000})).stdout;
    const diff = (await git('diff', 'HEAD', '--no-color')).slice(0, 60_000);
    const untracked = (await git('ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean).slice(0, 20);
    const added = untracked.map((f) => {
      try {
        return `--- new file ${f}\n${readFileSync(path.join(root, f), 'utf8').slice(0, 8000)}`;
      } catch {
        return '';
      }
    }).join('\n');
    if (!diff.trim() && !added.trim()) return undefined;
    const request = [...this.engine.transcript.messages].reverse().find((m) => m.role === 'user' && !/^<(code_check|stop_hook)>/.test(m.text))?.text ?? '';
    const system = 'You review a code change against the request that asked for it. Report only concrete problems: requirements or edge cases the request states that the change does not handle, and real bugs. No style comments, no praise.';
    const prompt = `The request:\n${request.slice(0, 20_000)}\n\nThe change (git diff, then new files):\n${diff}\n${added}\n\nList each problem on one line: the file, what is wrong, and which part of the request it breaks. If there are none, reply exactly NONE.`;
    const reply = (await completeWith(reviewer, this.config, system, prompt, {timeoutMs: 240_000})).trim(); // its tokens count via onSideUsage
    if (!reply || /^none\b/i.test(reply)) return undefined;
    return `${who ?? `A second model (${reviewer.provider}:${reviewer.model})`} reviewed your change against the request and reported:\n${reply.slice(0, 6000)}\nCheck each point against the code. Fix the ones that are real; for any that are wrong, say so in a line. Don't redo work that is fine.`;
  }

  /** escalate: the model the task moves to (set by stopHook, cleared by the user's next message). */
  escalation: ModelRef | undefined;

  /** The cheapest available model in a higher cost tier than the current one (same provider first). */
  private strongerModel(): ModelRef | undefined {
    const cur = this.engine?.currentRef();
    if (!cur) return undefined;
    const tier = catalog.get(cur)?.tier ?? 0;
    const up = catalog.available(this.config.maxUsedPct).filter((m) => m.tier > tier);
    const best = up.sort((a, b) => Number(b.provider === cur.provider) - Number(a.provider === cur.provider) || a.tier - b.tier)[0];
    return best ? toRef(best) : undefined;
  }

  /** Auto effort: one decision-model question (Jev or the cheap model) about how hard the message is. */
  private async pickEffort(text: string, levels: string[]): Promise<string | undefined> {
    const meaning: Record<string, string> = {
      low: 'simple questions, lookups, small mechanical edits',
      medium: 'typical coding tasks and explanations',
      high: 'tricky bugs, careful refactors, design decisions',
      xhigh: 'very hard, long multi-step problems that need deep reasoning',
    };
    const d = await decide(this.config, {user_message: headTail(text)}, {
      effort: {
        type: 'choice',
        instructions: 'How much reasoning effort does the assistant need for this message? Pick the lowest level that will do it well.',
        criteria: Object.fromEntries(levels.map((l) => [l, meaning[l] ?? l])),
      },
    });
    const a = d.answers.effort;
    return a?.type === 'choice' ? a.choice : undefined;
  }

  /** Decision model: is the subagent's task actually complete? (noul; ≥ 0.5 = yes) */
  private async judgeCompletion(agent: Subagent) {
    const tools = agent.events.flatMap((e) => (e.kind === 'tool' ? [`${e.label}(${e.summary})${e.ok === false ? ' ✗' : ''}`] : []));
    const d = await decide(this.config, {task: headTail(agent.task), final_report: headTail(agent.output), tool_calls: tools.slice(-40)}, {
      complete: {
        type: 'noul',
        instructions: 'Has the subagent fully completed the task it was given — actually done (not just planned, partially done, or blocked), with a final report?',
        criteria: {true: 'complete', false: 'incomplete, only planned, blocked, or stopped early'},
      },
    });
    const a = d.answers.complete;
    const p = a?.type === 'noul' ? a.noul : 1;
    return {complete: p >= 0.5, note: `${p >= 0.5 ? 'complete' : 'not complete'} (${p.toFixed(2)} via ${d.backend})`};
  }

  /** Fold new subagent tokens into the conversation totals and save its record. */
  private subagentFinished(agent: Subagent): void {
    const prev = this.folded.get(agent.id) ?? {input: 0, cached: 0, output: 0};
    this.engine.addTokens({input: agent.tokens.input - prev.input, cached: agent.tokens.cached - prev.cached, output: agent.tokens.output - prev.output, ...(agent.tokens.usd === undefined ? {} : {usd: agent.tokens.usd - (prev.usd ?? 0)})});
    this.folded.set(agent.id, {...agent.tokens});
    const t = this.engine.transcript;
    const record = {
      id: agent.id,
      name: agent.name,
      task: agent.task,
      mode: agent.mode,
      model: agent.ref ? refKey(agent.ref) : agent.requested,
      status: agent.status,
      output: agent.output,
      rounds: agent.rounds,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      tools: agent.events.flatMap((e) => (e.kind === 'tool' ? [{label: e.label, summary: e.summary, ok: e.ok}] : [])),
    };
    t.subagents = [...(t.subagents ?? []).filter((s) => s.id !== agent.id), record];
    void saveTranscript(t).catch(() => {});
  }

  async init(opts: {resume: Resume}): Promise<{resumed?: Transcript}> {
    this.workspace = findWorkspace();
    await this.vault.load();
    this.tools.shells.vault = this.vault;
    this.tools.shells.devEnv = this.devEnv;
    this.tools.shells.box = this.box;
    // provenance: what the trailers say, current at the moment of each command.
    this.tools.shells.extraEnv = (): Record<string, string> => {
      if (!this.config.provenance) return {};
      const ref = this.engine?.currentRef();
      const goal = this.goals.goal?.status === 'active' ? this.goals.goal.text.replace(/\s+/g, ' ').slice(0, 120) : '';
      return {REIN_SESSION: this.engine?.transcript.id ?? '', REIN_MODEL: ref ? `${ref.provider}:${ref.model}` : '', REIN_GOAL: goal};
    };
    setProvenance(() => this.config.provenance === true);
    setVaultNames(() => this.vault.names());
    this.vault.onChange(() => this.engine?.refreshTools()); // the system prompt lists the names
    this.tools.register(
      ...agentTools(this.agents, () => this.config),
      advisorTool({config: () => this.config, engine: () => this.engine, agents: this.agents}),
      goalDoneTool(this.goals),
      milestoneDoneTool(this.goals, (milestone) => {
        // Tasks the agent copied from this milestone are done with it.
        const t = this.engine?.transcript;
        if (!t?.todos?.some((x) => x.status !== 'completed' && isMilestoneCopy(x, [milestone]))) return;
        t.todos = t.todos.map((x) => (x.status !== 'completed' && isMilestoneCopy(x, [milestone]) ? {...x, status: 'completed'} : x));
        void saveTranscript(t).catch(() => {});
      }),
      ...webTools(() => this.config),
      affectedTool(() => activeExperiments(this.config), () => process.cwd()),
      repoMapTool(() => activeExperiments(this.config)),
      orgSearchTool(() => this.config),
      semanticSearchTool(() => this.config, () => process.cwd()),
      serviceGraphTool(() => activeExperiments(this.config), () => process.cwd()),
      symbolRefsTool(() => activeExperiments(this.config), () => process.cwd()),
      apiRefsTool(() => activeExperiments(this.config), () => process.cwd()),
      stackTool(() => activeExperiments(this.config), () => new LocalStack(this.workspace?.root ?? process.cwd()), async () => servicesForChange(this.workspace?.root ?? process.cwd(), findServices(process.cwd()))),
      skillTool(() => process.cwd(), () => (this.planMode = true)),
      ...memoryTools(() => process.cwd()),
      askUserTool(() => this.askPresenter),
      presentPlanTool({
        active: () => this.planMode,
        root: () => process.cwd(),
        present: async (plan) => (this.planPresenter ? this.planPresenter(plan) : undefined),
        review: (p) => this.reviewPlan('plan', `# ${p.title}\n\n${p.plan}\n\n## Milestones\n${p.milestones.map((m) => `- ${m}`).join('\n')}`),
        done: (decision, file, title) => {
          if (decision === 'revise') return;
          this.planMode = false;
          if (decision === 'goal') {
            this.goals.set(`Carry out the plan "${title}"`, file);
          }
        },
      }),
      ...specTools({
        active: () => (this.planMode ? this.specMode : undefined),
        root: () => process.cwd(),
        ask: () => this.askPresenter,
        review: (text) => this.reviewPlan('design', text),
        approved: () => {
          this.planMode = false;
          this.specMode = undefined;
        },
      }),
      decideTool(() => this.config),
      ...mcpTools({mcp: this.mcp, root: () => process.cwd(), call: (name, args, origin) => this.tools.call(name, args, origin)}),
      recallTool(() => this.engine?.transcript),
      todoTool({
        carried: () => activeExperiments(this.config).includes('todo-piggyback'),
        enabled: () => !activeExperiments(this.config).includes('no-todo'),
        transcript: () => this.engine?.transcript,
        milestones: () => (this.goals.goal?.status === 'active' ? this.goals.plan()?.milestones.map((m) => m.text) : undefined),
        changed: () => {
          if (this.engine) void saveTranscript(this.engine.transcript).catch(() => {});
        },
      }),
      imageTool(() => this.config),
      {
        name: 'diagnostics',
        label: 'Diagnostics',
        description:
          "Problems (type errors, lint findings…) in a file (path) or the whole workspace, from the user's editor if connected, else from language servers Rein runs (most languages). Problems your changes leave are also reported when you finish a turn; use this to check a file or the state before you start.",
        inputSchema: {type: 'object', properties: {path: {type: 'string', description: 'A file (project-relative or absolute); omit for the whole workspace'}}},
        mutating: false,
        summarize: (a: any) => a?.path ?? 'workspace',
        run: async (ctx: {root: string}, a: any) => {
          const root = ctx?.root ?? process.cwd();
          const file = typeof a?.path === 'string' ? path.resolve(root, a.path) : undefined;
          if (this.ide) return {ok: true, text: `[from the editor]\n${(await this.ide.diagnostics(file)) || 'No problems reported.'}`};
          if ((this.config.lsp ?? 'auto') === 'off') return {ok: false, text: 'no editor is connected and built-in language servers are off (config lsp: "off")'};
          const known = file ? this.lsp.spec(file) : undefined;
          if (file && !known) return {ok: false, text: `Rein has no built-in language server for ${path.basename(file)}, and no editor is connected. (The user can configure one in config.json lspServers.)`};
          if (known && !known.installed) {
            const can = installable(known.spec);
            return {ok: false, text: can.ok ? `The ${known.spec.name} language server isn't installed. Ask the user whether to install it, then call lsp_install {server: "${known.spec.id}"} (it asks them too).` : `The ${known.spec.name} language server isn't installed, and Rein can't install it itself: ${can.why}`};
          }
          const text = await this.lsp.diagnostics(root, file);
          return {ok: true, text: `[from Rein's language servers]\n${text ?? 'No problems in the files opened so far (pass a path to check a specific file).'}`};
        },
      },
      {
        name: 'lsp_install',
        label: 'InstallLanguageServer',
        // Kept short: it's in every request, and the server id comes from the diagnostics result or edit note that suggests it.
        description: "Install a language server for code intelligence into Rein's own folder. server: the id from the diagnostics result or edit note that suggested it (e.g. \"cpp\", \"rust\", \"java\"). Always asks the user; only use it when they want it.",
        inputSchema: {type: 'object', properties: {server: {type: 'string'}}, required: ['server']},
        mutating: true,
        alwaysAsk: true,
        askEvenInBypass: true,
        summarize: (a: any) => String(a?.server ?? ''),
        run: async (_ctx: unknown, a: any) => {
          const spec = serverById(String(a?.server));
          if (!spec) return {ok: false, text: `unknown server "${a?.server}". Servers Rein can install: ${SERVERS.filter((x) => x.install.kind !== 'manual').map((x) => x.id).join(', ')}`};
          return installServer(spec);
        },
      },
    );
    this.config = await loadConfig();
    catalog.apiAccounts = this.config.apiAccounts ?? 'fallback';
    await this.sessionStartHooks(typeof opts.resume === 'string' ? 'resume' : 'startup');
    // MCP servers connect in the background; their tools appear as they come up.
    this.tools.addSource(() => this.mcp.tools());
    let mcpToolSet = '';
    this.mcp.on('change', () => {
      // Only a different tool list needs new sessions (status changes alone don't).
      const now = this.mcp.tools().map((t) => t.name).sort().join(',');
      if (now !== mcpToolSet) {
        mcpToolSet = now;
        this.engine?.refreshTools();
      }
    });
    this.mcp.pinning = () => this.config.mcpPinning === true;
    // MCP sampling: servers may ask for a completion, answered with the user's subscriptions.
    this.mcp.sampling = samplingHandler({
      config: () => this.config,
      // Looked up per request: the UI sets the approver after start-up (headless never does: refused).
      approve: async (server, model, preview) => {
            if (!this.approver) return 'deny';
            const d = await this.approver({
              tool: {name: 'mcp_sampling', label: 'use a model', description: '', inputSchema: {type: 'object', properties: {}}, mutating: false, run: async () => ({ok: true, text: ''}), summarize: () => ''},
              args: {},
              summary: `(${catalog.get(model)?.label ?? model.model}) for the MCP server "${server}"`,
              preview,
              sessionLabel: `Allow "${server}" to use models this session`,
            });
            return d === 'deny' ? 'deny' : d === 'once' ? 'once' : 'session';
          },
    });
    void this.mcp.start().catch(() => {});
    this.stopUsageRefresh = startUsageRefresh({balancing: () => this.config.loadBalancing !== 'sticky', busy: (id) => catalog.busy.get(id) ?? 0});
    setExtraWorkingDirs(() => this.tools.extraWorkingDirs());
    setScopeDir(() => this.scope);
    setAttribution(() => this.config.attribution !== false);
    setLazyTools(() => activeExperiments(this.config).includes('lazy-tools'));
    setCheapExplore(() => activeExperiments(this.config).includes('cheap-explore'));
    setNoTodo(() => activeExperiments(this.config).includes('no-todo'));
    setInScope(() => activeExperiments(this.config).includes('in-scope'));
    setManyCalls(() => activeExperiments(this.config).includes('many-calls'));
    setSelfTest(() => activeExperiments(this.config).includes('self-test'));
    setEnabledPacks(() => this.config.packs ?? []);
    setExtensionCommands(() => extensions.commands.map((c) => c.value));
    setPromptCacheTtl(() => (activeExperiments(this.config).includes('cache-5m') ? '5m' : undefined));
    setCacheWriteTtl(() => (activeExperiments(this.config).includes('cache-5m') ? '5m' : '1h'));
    setPriceOverrides(() => this.config.prices);
    setSaveFilter((line) => (this.config.secretScan && this.config.secretScan !== 'off' ? maskSecrets(line) : line));
    setBriefFinal(() => activeExperiments(this.config).includes('brief-final'));
    await usageStore.load();
    const router = makeRouter(() => this.config, (...a) => this.auto(...a));
    const host = this.tools;
    host.on('activity', (a: ToolActivity) => this.telemetry.activity(a));
    const resumed = typeof opts.resume === 'string' ? await loadTranscript(opts.resume) : undefined;
    this.engine = new Engine(
      {
        config: () => this.config,
        route: async (text, t, current) => {
          const route = this.escalation ? {ref: this.escalation, reason: 'escalated' as const} : await router.route(text, t, current);
          const blocked = modelBlocked(loadPolicy(process.cwd(), reinConfigDir()), route.ref);
          if (blocked) throw new Error(`${blocked}. Pick a model it allows with /model.`);
          return route;
        },
        alternative: router.alternative,
        compact: (t, reason, opts) => this.compact(t, reason, opts),
        selectCarry: (input) => this.selectCarry(input),
        pickEffort: (text, levels) => this.pickEffort(text, levels),
        beforePrompt: (text) => this.beforePrompt(text),
        overBudget: () => this.checkBudget(),
        onTurnEnd: (turn) => this.telemetry.turnEnd({...turn, endedAt: Date.now(), sessionId: this.engine?.transcript.id}),
        onConversationChange: () => {
          this.tools.reads.clear();
          this.tools.untrustedSeen = this.tools.privateSeen = undefined;
          this.tools.deliveredInstructions.clear();
        },
        tools: {
          binding: {
            // Resolved when a session opens: the agent tool lists the models signed in right now.
            get tools() {
              return host.specs();
            },
            call: (name, args) => this.tools.callInOrder(name, args),
            listen: () => this.tools.listen(),
            proxy: mcpProxyCommand(),
          },
          forkBinding: {
            get tools() {
              return host.specs();
            },
            call: (name, args) => this.tools.readOnly().call(name, args),
            listen: () => this.tools.listenReadOnly(),
            proxy: mcpProxyCommand(),
            allowed: this.tools.tools.filter((t) => !t.mutating && !t.mainOnly).map((t) => t.name),
          },
          onActivity: (fn: (a: ToolActivity) => void) => {
            this.tools.on('activity', fn);
            return () => void this.tools.off('activity', fn);
          },
        },
      },
      resumed,
    );
    // Helper calls (compaction, decisions, advisor, reviews, web_fetch) count toward the conversation.
    this.stopSideUsage?.();
    this.stopSideUsage = onSideUsage((_ref, t) => this.engine.addTokens(t));
    return {resumed};
  }

  private stopSideUsage?: () => void;

  /**
   * Remove an account without interrupting anything: it's retired at once (no new turns or
   * subagents use it), the conversation and subagents release their sessions on it (running turns
   * finish first), and the next message continues on another account with the context carried
   * over. Logout and file cleanup happen when nothing uses the account any more.
   */
  async removeAccount(account: Account): Promise<void> {
    catalog.retired.add(account.id);
    this.engine?.releaseAccount(account.id);
    this.agents.releaseAccount(account.id);
    const idle = async () => {
      while (catalog.busy.get(account.id)) await new Promise((r) => setTimeout(r, 1000));
      if (account.provider === 'codex') releaseCodexAccount(account.id);
    };
    const done = removeAccount(account, idle).finally(() => {
      catalog.retired.delete(account.id);
      this.pendingRemovals.delete(done);
    });
    this.pendingRemovals.add(done);
    await this.refreshCatalog(); // unregistered: gone from /login, /usage and model lists
  }
  private pendingRemovals = new Set<Promise<void>>();

  /** Reload accounts/models (after /login changes). */
  async refreshCatalog(): Promise<void> {
    const hadImages = !!imageGenRef(this.config);
    await catalog.refresh();
    // image_generate exists only while a Codex account is signed in: reload tool lists on change.
    if (hadImages !== !!imageGenRef(this.config)) this.engine?.refreshTools();
  }

  async setConfig(patch: Partial<Config>): Promise<void> {
    // These change what tools exist or their schemas: reload the agent's tool list.
    // (attribution changes the system prompt: same reload.)
    const toolsChanged =
      (['advisorModel', 'subagentModel', 'subagentPriority', 'attribution'] as const).some((k) => patch[k] !== undefined && patch[k] !== this.config[k]) ||
      (patch.experiments !== undefined && JSON.stringify(patch.experiments) !== JSON.stringify(this.config.experiments)); // they change tools and schemas
    this.config = {...this.config, ...patch};
    catalog.apiAccounts = this.config.apiAccounts ?? 'fallback';
    if (toolsChanged) this.engine?.refreshTools();
    if (patch.pet !== undefined) void this.pets.refresh().catch(() => {});
    await saveConfig(this.config);
  }

  shutdown(): void {
    this.pets.close();
    this.ci.stop();
    void this.box.stop();
    void this.mcp.closeAll();
    void this.ide?.close();
    void this.lsp.closeAll();
    void this.remote?.stop();
    this.trackers.stop();
    this.stopUsageRefresh();
    this.agents.closeAll();
    this.engine?.shutdown();
    this.stopSideUsage?.();
    this.tools.close();
    for (const a of Object.values(adapters)) a.shutdown();
  }
}

export const runtime = new Runtime();
