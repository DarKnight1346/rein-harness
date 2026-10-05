import {adapters} from './providers/index.js';
import {catalog} from './router/catalog.js';
import {mergeNote, Worktrees} from './agents/worktrees.js';
import type {Origin} from './tools/fs.js';
import {makeRouter, type AutoRouter} from './router/index.js';
import {LspManager, type Before} from './lsp/manager.js';
import {installServer, serverById, SERVERS} from './lsp/servers.js';
import {makeAutoRouter} from './router/auto.js';
import {Engine} from './session/engine.js';
import {compactTranscript, type CompactReason, type CompactResult} from './session/compactor.js';
import {loadTranscript, type Transcript} from './session/transcript.js';

/** `true` = show the picker, a string = continue that session id, `false` = new conversation. */
export type Resume = boolean | string;
import {DEFAULT_CONFIG, loadConfig, saveConfig, type Config} from './store/config.js';
import {usageStore} from './store/usage.js';
import {SubagentManager, SUBAGENT_PROMPT, type Subagent} from './agents/manager.js';
import {agentTools} from './agents/tools.js';
import {advisorRef, advisorTool} from './agents/advisor.js';
import {GoalManager} from './goals/manager.js';
import {Checkpoints} from './session/checkpoints.js';
import {TreeSnapshots} from './session/snapshots.js';
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
import {newTranscript, saveTranscript} from './session/transcript.js';
import {setAttribution, setExtraWorkingDirs, setVaultNames, systemPrompt} from './session/prompt.js';
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

/** Process-wide state shared by the UI and commands. */
export class Runtime {
  config: Config = DEFAULT_CONFIG;
  engine!: Engine;
  /** Last auto-routing decision, for the status line / debugging. */
  lastDecision: string | undefined;
  auto: AutoRouter = makeAutoRouter({config: () => this.config, onDecision: (d) => (this.lastDecision = d)});
  compact = (t: Transcript, _reason: CompactReason, opts?: {keepRecent?: number}): Promise<CompactResult> => {
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
  planMode = false;
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
    configDirs: () => this.config?.additionalDirectories ?? [],
    checkpoint: (file) => this.checkpoints.snapshot(this.currentTurn(), file),
    mask: (text) => this.vault.mask(text),
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

  /** Built-in code intelligence: language servers Rein runs itself (lsp/manager.ts). */
  readonly lsp = new LspManager({config: () => this.config});

  /** File checkpoints for /rewind, per conversation (Rein's own file changes, ignored files too). */
  readonly checkpoints = new Checkpoints(() => this.engine?.transcript.id ?? 'none');
  /** Whole-tree snapshots for /rewind (covers shell-made changes); see snapshots.ts. */
  readonly snapshots = new TreeSnapshots(process.cwd(), () => this.engine?.transcript.id ?? 'none');

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
          call: (name, args) => (permitted(name) ? host.call(name, args, origin) : Promise.resolve({ok: false, text: `${name} isn't available to the ${agent.definition?.name} subagent`})),
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
      if (r.kept) this.tools.addDirs([r.kept]); // the main agent merges the conflicting files from there
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
    const account = catalog.healthyAccounts(ref, this.config.maxUsedPct)[0];
    if (!account) throw new Error(`no healthy account for ${ref.model}`);
    const role = agent.definition ? `\n\n# Your role: ${agent.definition.name}\n${agent.definition.prompt}` : '';
    const prompt = `${await systemPrompt({tools: true, scratch: this.engine.scratch})}\n\n${SUBAGENT_PROMPT(agent.name)}${role}`;
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
    const context = [this.sessionContext, out.context, shells, selection, this.planMode ? PLAN_MODE_CONTEXT : undefined].filter(Boolean).join('\n');
    if (!out.block) this.userShells = [];
    if (!out.block) this.sessionContext = undefined;
    return {block: out.block, context: context || undefined};
  }

  /**
   * Stop hooks after a reply: exit 2 / decision "block" keeps the agent going with the reason as
   * its next instruction. `active` is true while continuing because of a Stop hook (as in Claude Code).
   */
  async stopHook(active: boolean): Promise<string | undefined> {
    const root = process.cwd();
    if (!hasHooks('Stop', root)) return undefined;
    const out = await runHooks('Stop', root, {session_id: this.engine?.transcript.id, stop_hook_active: active});
    return out.block;
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
    this.engine.addTokens({input: agent.tokens.input - prev.input, cached: agent.tokens.cached - prev.cached, output: agent.tokens.output - prev.output});
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
    await this.vault.load();
    this.tools.shells.vault = this.vault;
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
      skillTool(() => process.cwd(), () => (this.planMode = true)),
      ...memoryTools(() => process.cwd()),
      askUserTool(() => this.askPresenter),
      presentPlanTool({
        active: () => this.planMode,
        root: () => process.cwd(),
        present: async (plan) => (this.planPresenter ? this.planPresenter(plan) : undefined),
        done: (decision, file, title) => {
          if (decision === 'revise') return;
          this.planMode = false;
          if (decision === 'goal') {
            this.goals.set(`Carry out the plan "${title}"`, file);
          }
        },
      }),
      decideTool(() => this.config),
      ...mcpTools({mcp: this.mcp, root: () => process.cwd(), call: (name, args, origin) => this.tools.call(name, args, origin)}),
      todoTool({
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
          "Problems (type errors, lint findings…) in a file (path) or the whole workspace, from the user's editor when one is connected, otherwise from language servers Rein runs itself (TypeScript/JavaScript, Python). Use it after changes to check you didn't break anything. File edits already report new problems they introduce.",
        inputSchema: {type: 'object', properties: {path: {type: 'string', description: 'A file (project-relative or absolute); omit for the whole workspace'}}},
        mutating: false,
        summarize: (a: any) => a?.path ?? 'workspace',
        run: async (ctx: {root: string}, a: any) => {
          const root = ctx?.root ?? process.cwd();
          const file = typeof a?.path === 'string' ? path.resolve(root, a.path) : undefined;
          if (this.ide) return {ok: true, text: `[from the editor]\n${(await this.ide.diagnostics(file)) || 'No problems reported.'}`};
          if ((this.config.lsp ?? 'auto') === 'off') return {ok: false, text: 'no editor is connected and built-in language servers are off (config lsp: "off")'};
          const known = file ? this.lsp.spec(file) : undefined;
          if (file && !known) return {ok: false, text: `Rein has no built-in language server for ${path.extname(file) || 'this file'} files yet (TypeScript/JavaScript and Python), and no editor is connected.`};
          if (known && !known.installed) return {ok: false, text: `The ${known.spec.name} language server isn't installed. Ask the user whether to install it, then call lsp_install {server: "${known.spec.id}"} (it asks them too).`};
          const text = await this.lsp.diagnostics(root, file);
          return {ok: true, text: `[from Rein's language servers]\n${text ?? 'No problems in the files opened so far (pass a path to check a specific file).'}`};
        },
      },
      {
        name: 'lsp_install',
        label: 'InstallLanguageServer',
        description: `Install a language server Rein runs for code intelligence (diagnostics, and new problems reported after each edit), into Rein's own folder with npm. Servers: ${SERVERS.map((s) => `"${s.id}" (${s.name})`).join(', ')}. Always asks the user; only use it when they want it.`,
        inputSchema: {type: 'object', properties: {server: {type: 'string', enum: SERVERS.map((s) => s.id)}}, required: ['server']},
        mutating: true,
        alwaysAsk: true,
        askEvenInBypass: true,
        summarize: (a: any) => String(a?.server ?? ''),
        run: async (_ctx: unknown, a: any) => {
          const spec = serverById(String(a?.server));
          if (!spec) return {ok: false, text: `unknown server "${a?.server}"`};
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
    void this.mcp.start().catch(() => {});
    this.stopUsageRefresh = startUsageRefresh({balancing: () => this.config.loadBalancing !== 'sticky', busy: (id) => catalog.busy.get(id) ?? 0});
    setExtraWorkingDirs(() => this.tools.extraWorkingDirs());
    setAttribution(() => this.config.attribution !== false);
    await usageStore.load();
    const router = makeRouter(() => this.config, (...a) => this.auto(...a));
    const host = this.tools;
    const resumed = typeof opts.resume === 'string' ? await loadTranscript(opts.resume) : undefined;
    this.engine = new Engine(
      {
        config: () => this.config,
        route: router.route,
        alternative: router.alternative,
        compact: (t, reason, opts) => this.compact(t, reason, opts),
        selectCarry: (input) => this.selectCarry(input),
        pickEffort: (text, levels) => this.pickEffort(text, levels),
        beforePrompt: (text) => this.beforePrompt(text),
        onConversationChange: () => {
          this.tools.reads.clear();
          this.tools.deliveredInstructions.clear();
        },
        tools: {
          binding: {
            // Resolved when a session opens: the agent tool lists the models signed in right now.
            get tools() {
              return host.specs();
            },
            call: (name, args) => this.tools.call(name, args),
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
    return {resumed};
  }

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
    const toolsChanged = (['advisorModel', 'subagentModel', 'subagentPriority', 'attribution'] as const).some((k) => patch[k] !== undefined && patch[k] !== this.config[k]);
    this.config = {...this.config, ...patch};
    catalog.apiAccounts = this.config.apiAccounts ?? 'fallback';
    if (toolsChanged) this.engine?.refreshTools();
    await saveConfig(this.config);
  }

  shutdown(): void {
    void this.mcp.closeAll();
    void this.ide?.close();
    void this.lsp.closeAll();
    this.stopUsageRefresh();
    this.agents.closeAll();
    this.engine?.shutdown();
    this.tools.close();
    for (const a of Object.values(adapters)) a.shutdown();
  }
}

export const runtime = new Runtime();
