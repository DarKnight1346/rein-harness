import {adapters} from './providers/index.js';
import {catalog} from './router/catalog.js';
import {makeRouter, type AutoRouter} from './router/index.js';
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
import {McpManager} from './mcp/manager.js';
import {startUsageRefresh} from './accounts/usage.js';
import {hasHooks, runHooks} from './hooks.js';
import {goalDoneTool} from './goals/tool.js';
import {webTools} from './tools/web.js';
import {todoTool} from './tools/todo.js';
import {imageGenRef, imageTool} from './tools/image.js';
import {newTranscript, saveTranscript} from './session/transcript.js';
import {setExtraWorkingDirs, systemPrompt} from './session/prompt.js';
import {parseRef, refKey, type Account, type ModelRef, type TokenCount, type ToolBinding} from './providers/types.js';
import {removeAccount} from './accounts/service.js';
import {releaseCodexAccount} from './providers/codex/adapter.js';
import {completeWith, decide, resolveUtilityModel} from './decider/index.js';
import {parseIndices} from './session/carry.js';
import {headTail} from './router/auto.js';

/** `auto` approval mode: allow without asking only at this confidence or higher. */
const AUTO_APPROVE_MIN = 0.85;
import {mcpProxyCommand, ToolHost, type ApprovalDecision, type ApprovalRequest, type ToolActivity} from './tools/host.js';

/** Process-wide state shared by the UI and commands. */
export class Runtime {
  config: Config = DEFAULT_CONFIG;
  engine!: Engine;
  /** Last auto-routing decision, for the status line / debugging. */
  lastDecision: string | undefined;
  auto: AutoRouter = makeAutoRouter({config: () => this.config, onDecision: (d) => (this.lastDecision = d)});
  compact = (t: Transcript, _reason: CompactReason): Promise<CompactResult> => compactTranscript(t, this.config);

  /** Rules for this run only (headless --allowedTools / --disallowedTools). */
  extraRules: {allow: string[]; deny: string[]} = {allow: [], deny: []};
  /** Set by the UI: shows the approval prompt for a file-changing tool call. */
  approver: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;
  readonly tools = new ToolHost({
    root: process.cwd(),
    approve: (req) => (this.approver ? this.approver(req) : Promise.resolve('deny')),
    extraRules: () => this.extraRules,
    mode: () => this.config.toolApproval,
    shellMaxMs: () => this.config.shellMaxMinutes * 60_000,
    scratch: () => this.engine?.scratch,
    sessionId: () => this.engine?.transcript.id,
    judge: (req) => this.judgeChange(req),
    configDirs: () => this.config?.additionalDirectories ?? [],
    checkpoint: (file) => this.checkpoints.snapshot(this.currentTurn(), file),
  });

  /** MCP servers (project .mcp.json, ~/.rein/mcp.json, Claude Code's ~/.claude.json). */
  readonly mcp = new McpManager(process.cwd());

  /** File checkpoints for /rewind, per conversation. */
  readonly checkpoints = new Checkpoints(() => this.engine?.transcript.id ?? 'none');

  /** Index of the user message the agent is working on (checkpoints are grouped by it). */
  currentTurn(): number {
    const m = this.engine?.transcript.messages ?? [];
    for (let i = m.length - 1; i >= 0; i--) if (m[i]!.role === 'user') return i;
    return 0;
  }

  /**
   * `auto` approvals: one decision-model call (Jev or the cheap LLM) with minimal state — the user's
   * latest request, the action and a clipped preview. Allows only confident "clearly requested and
   * safe" verdicts; everything else is shown to the user.
   */
  private async judgeChange(req: ApprovalRequest): Promise<{allow: boolean; note: string}> {
    const lastUser = [...(this.engine?.transcript.messages ?? [])].reverse().find((m) => m.role === 'user');
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
      let closeSocket: (() => void) | undefined;
      const host = this.tools;
      return {
        binding: {
          // Fork-mode histories reference agent/agent_result, so forks still see their definitions.
          get tools() {
            return host.specs({subagent: true, includeMainOnly: agent.mode === 'fork'});
          },
          call: (name, args) => host.call(name, args, origin),
          listen: async () => {
            const l = await host.listenFor(origin);
            closeSocket = l.close;
            return l.socket;
          },
          proxy: mcpProxyCommand(),
          allowed: host.specs({subagent: true}).map((t) => t.name),
        },
        close: () => closeSocket?.(),
      };
    },
    judge: (agent) => this.judgeCompletion(agent),
    onActivity: (agentId, fn) => {
      const h = (a: ToolActivity) => {
        if (a.origin?.agentId === agentId) fn(a);
      };
      this.tools.on('activity', h);
      return () => void this.tools.off('activity', h);
    },
    finished: (agent) => this.subagentFinished(agent),
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
    let ref: ModelRef | undefined;
    if (agent.requested === 'auto') {
      const t = newTranscript();
      t.messages.push({role: 'user', text: agent.task, at: Date.now()});
      ref = (await this.auto(agent.task, t, undefined, new Set())).ref;
    } else {
      ref = parseRef(agent.requested);
      if (!ref || !catalog.get(ref)) throw new Error(`model ${agent.requested} isn't available; use one from the tool description or "auto"`);
    }
    const account = catalog.healthyAccounts(ref, this.config.maxUsedPct)[0];
    if (!account) throw new Error(`no healthy account for ${ref.model}`);
    const prompt = `${await systemPrompt({tools: true, scratch: this.engine.scratch})}\n\n${SUBAGENT_PROMPT(agent.name)}`;
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

  private async beforePrompt(text: string): Promise<{block?: string; context?: string}> {
    const root = process.cwd();
    const session_id = this.engine?.transcript.id;
    const out = hasHooks('UserPromptSubmit', root) ? await runHooks('UserPromptSubmit', root, {session_id, prompt: text}) : {errors: []};
    const context = [this.sessionContext, out.context].filter(Boolean).join('\n');
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
    this.tools.register(
      ...agentTools(this.agents, () => this.config),
      advisorTool({config: () => this.config, engine: () => this.engine, agents: this.agents}),
      goalDoneTool(this.goals),
      ...webTools(() => this.config),
      todoTool({
        transcript: () => this.engine?.transcript,
        changed: () => {
          if (this.engine) void saveTranscript(this.engine.transcript).catch(() => {});
        },
      }),
      imageTool(() => this.config),
    );
    this.config = await loadConfig();
    // SessionStart hooks: their output becomes context for the first message.
    if (hasHooks('SessionStart', process.cwd())) {
      const out = await runHooks('SessionStart', process.cwd(), {source: typeof opts.resume === 'string' ? 'resume' : 'startup'}).catch(() => undefined);
      this.sessionContext = out?.context;
    }
    // MCP servers connect in the background; their tools appear as they come up.
    this.tools.addSource(() => this.mcp.tools());
    let mcpTools = '';
    this.mcp.on('change', () => {
      // Only a different tool list needs new sessions (status changes alone don't).
      const now = this.mcp.tools().map((t) => t.name).sort().join(',');
      if (now !== mcpTools) {
        mcpTools = now;
        this.engine?.refreshTools();
      }
    });
    void this.mcp.start().catch(() => {});
    this.stopUsageRefresh = startUsageRefresh({balancing: () => this.config.loadBalancing !== 'sticky', busy: (id) => catalog.busy.get(id) ?? 0});
    setExtraWorkingDirs(() => this.tools.extraWorkingDirs());
    await usageStore.load();
    const router = makeRouter(() => this.config, (...a) => this.auto(...a));
    const host = this.tools;
    const resumed = typeof opts.resume === 'string' ? await loadTranscript(opts.resume) : undefined;
    this.engine = new Engine(
      {
        config: () => this.config,
        route: router.route,
        alternative: router.alternative,
        compact: (t, reason) => this.compact(t, reason),
        selectCarry: (input) => this.selectCarry(input),
        pickEffort: (text, levels) => this.pickEffort(text, levels),
        beforePrompt: (text) => this.beforePrompt(text),
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
    const toolsChanged = (['advisorModel', 'subagentModel', 'subagentPriority'] as const).some((k) => patch[k] !== undefined && patch[k] !== this.config[k]);
    this.config = {...this.config, ...patch};
    if (toolsChanged) this.engine?.refreshTools();
    await saveConfig(this.config);
  }

  shutdown(): void {
    void this.mcp.closeAll();
    this.stopUsageRefresh();
    this.agents.closeAll();
    this.engine?.shutdown();
    this.tools.close();
    for (const a of Object.values(adapters)) a.shutdown();
  }
}

export const runtime = new Runtime();
