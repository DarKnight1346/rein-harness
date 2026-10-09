import {secretsDir} from '../store/secrets.js';
import {EventEmitter} from 'node:events';
import {existsSync, mkdirSync, realpathSync, rmSync, statSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {retarget} from '../agents/worktrees.js';
import {resolveInRoot, resolvePath, toPosix, ToolError, workingDirs, type FileStamp, type Origin, type ToolContext, type ToolResult} from './fs.js';
import {TOOLS, toolByName, type ToolDef} from './registry.js';
import {addProjectRule, check, loadRules, ruleTool, suggestRule, type Rules, type Subject} from './permissions.js';
import {hasHooks, runHooks} from '../hooks.js';
import {renderScoped, scopedInstructions} from '../session/prompt.js';
import {Watchdog} from './watchdog.js';
import {addedText, findSecrets, secretMessage} from './secrets.js';
import {injectionSigns, injectionWarning, networkCapable, untrustedSource} from './untrusted.js';
import {addedDeps, afterEdit, checkDeps, commandDeps, depMessage} from './deps.js';
import {readOnlyCommand} from './plan.js';
import {steer} from './steer.js';
import {ipcPath, isWindows} from '../util/platform.js';
import {ShellManager} from './shells.js';
import type {DiffLine} from './diff.js';
import {skillDirs} from '../skills/index.js';

type Lane = {running: Set<Promise<unknown>>; barrier: Promise<unknown>; lastDone: number; inResponse: number; single: number; nudgeAt: number};
/** Calls this close to the previous result come from the same model response. */
const SAME_RESPONSE_MS = 400;
/** many-calls: single-call responses in a row before Rein reminds the model to batch. */
const NUDGE_AFTER = 4;

export type ApprovalRequest = {
  tool: ToolDef;
  args: any;
  summary: string;
  preview: string;
  origin?: Origin;
  /** Paths outside the working directories this call would touch (asks about access, not just the change). */
  outside?: string[];
  /** One of them is a credentials/secrets location: no "allow for the session" option. */
  sensitive?: boolean;
  /** Rule offered as "always allow …" (saved to the project's .rein/settings.json). */
  suggestion?: string;
  /** Plan mode: a command not known to be read-only — only "allow once" or deny. */
  planMode?: boolean;
  /** What "allow for the session" covers, when it isn't changes and commands (an MCP server's sampling…). */
  sessionLabel?: string;
  /** Why this needs your yes even in bypass (exfilGuard): only allow once or deny. */
  reason?: string;
};
export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';
export type ApprovalMode = 'ask' | 'auto' | 'bypass';
/** How a file change got approved (shown in the transcript). */
export type ApprovedBy = 'user' | 'session' | 'auto' | 'bypass' | 'scratchpad' | 'rule' | 'hook' | 'read-only';
export type ToolActivity =
  | {phase: 'start'; id: number; label: string; summary: string; origin?: Origin}
  | {phase: 'end'; id: number; label: string; summary: string; ok: boolean; result: string; approvedBy?: ApprovedBy; judge?: string; origin?: Origin; diff?: DiffLine[]; warning?: string};

/** Tool definition as sent to a model. */
export type ToolSpec = {name: string; description: string; inputSchema: Record<string, unknown>};

export type ToolHostOptions = {
  root: string;
  /** Ask the user about a mutating call; resolves with their decision. */
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  mode: () => ApprovalMode;
  /** Current session's scratchpad (created on demand); file changes inside it skip approval. */
  scratch?: () => string | undefined;
  sessionId?: () => string | undefined;
  /** Foreground shell cap in ms (0 = none), read per call so /settings applies at once. */
  shellMaxMs?: () => number;
  /** The sandbox mode for the agent's shell commands (/settings → Sandbox). */
  sandbox?: () => import('./sandbox.js').SandboxMode;
  /** `auto` mode: the decision model's verdict; `ask` falls through to the user. */
  judge?: (req: ApprovalRequest) => Promise<{allow: boolean; note: string}>;
  /** Extra working directories from config (`additionalDirectories`). */
  configDirs?: () => string[];
  /** injectionScan: flag instructions planted in web pages, search results and MCP results. */
  injectionScan?: () => boolean;
  /** exfilGuard: network calls need a yes once untrusted content and private data are both in the conversation. */
  exfilGuard?: () => boolean;
  /** depCheck: vet packages a change adds (exists, typosquat, license, known vulnerabilities). */
  depCheck?: () => 'off' | 'warn' | 'block';
  /** secretScan: what to do when a write or edit adds something that looks like a credential. */
  secretScan?: () => 'off' | 'warn' | 'block';
  /** --scope / /scope: list, search and shell default to this folder (absolute) instead of the project root. */
  scope?: () => string | undefined;
  /** Extra rules for this run only (headless --allowedTools / --disallowedTools). */
  extraRules?: () => Rules;
  /** Plan mode: file changes and non-read-only commands are refused until the plan is approved. */
  /** Plan mode: does this command only read? (decision model) — lets unlisted queries run. */
  readOnlyJudge?: (command: string) => Promise<{readOnly: boolean; note: string}>;
  planMode?: () => boolean;
  /** Calls from this origin are untrusted (work started by an issue): approvals always ask. */
  untrusted?: (origin: Origin) => boolean;
  /** Save a file's state before a tool changes it (checkpoints for /rewind). */
  checkpoint?: (file: string) => Promise<void>;
  /** Run simple shell reads/searches (cat, grep, sed -n…) as the built-in tools (default on). */
  steerShell?: () => boolean;
  /** Efficiency experiments that are on (config `experiments`). */
  experiments?: () => string[];
  /** The model context results go to now (engine.contextId): a change means earlier results may be gone. */
  contextId?: () => string | undefined;
  /** Mask secrets (the vault) in every tool result before the model, hooks or the transcript see it. */
  mask?: (text: string) => string;
  /**
   * Code intelligence around file changes (lsp/manager.ts): `before` snapshots the files' current
   * diagnostics, `after` returns a note on problems the change introduced (appended to the result).
   * `read` warms the server up; `shell` re-syncs files a command may have changed.
   */
  diagnostics?: {
    before(files: string[], root: string): Promise<unknown>;
    after(snapshot: unknown): Promise<string | undefined>;
    read?(file: string, root: string): void;
    shell?(root: string): void;
  };
  /**
   * A subagent's own copy of the project (a git worktree), if it has or now needs one: `writes`
   * says whether this call changes things. Its calls then run there, paths retargeted.
   */
  isolate?: (origin: Origin, writes: boolean) => Promise<{root: string; writable: string[]} | undefined>;
};

const MAX_RESULT_CHARS = 60_000;
/** Commands whose passing output is mostly noise (every test listed): quiet-passing-output trims them. */
const BUILD_OR_TEST = /(^|[;&|(\s])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b|(^|[;&|(\s])(npx\s+)?(tsc|jest|vitest|mocha|pytest|tox|cargo\s+(test|build|check)|go\s+(test|build|vet)|make|cmake|ctest|gradle|mvn|dotnet\s+(test|build)|mix\s+test|rspec|phpunit|swift\s+(test|build)|python3?\s+-m\s+(pytest|unittest)|node\s+--test)\b/;
const QUIET_KEEP = 25;

/**
 * Runs Rein's tools for whichever provider is chatting: Claude reaches it through the MCP proxy
 * over a unix socket, Codex calls `call()` in-process. Emits `activity` for the transcript.
 */
const realRoot = (p: string) => {
  try {
    return realpathSync.native(p); // the long form on Windows (not RUNNER~1)
  } catch {
    return p;
  }
};

export class ToolHost extends EventEmitter {
  private sessionAllowed = false;
  /**
   * Batching nudges: a model that edits (or reads) one thing per call pays a round trip each time.
   * The second single call in a row gets a one-line note about edits / paths, once per session:
   * models follow what tool results tell them more than what the tool description says.
   */
  /** reread-unchanged: whole-file reads the current model context has seen, by file. */
  private shown = new Map<string, {context: string; mtimeMs: number; size: number; lines: number}>();
  private streak = {tool: '', n: 0};
  private nudged = new Set<string>();
  /** "Allow reads outside the project this session" was chosen. */
  private outsideReadsAllowed = false;
  /** Working directories added this session (/add-dir, --add-dir, "allow this folder"). */
  private addedDirs: string[] = [];
  /** Files read in this conversation (stale-file protection); cleared when the conversation changes. */
  readonly reads = new Map<string, FileStamp>();
  /** Subfolder instruction files already given to the agent (cleared on new conversation / compaction). */
  readonly deliveredInstructions = new Set<string>();
  /** Processes started by the shell tool (foreground + background). */
  readonly shells = new ShellManager();
  private nextId = 1;
  private servers: net.Server[] = [];
  private sockets: string[] = [];
  private mainSocket: Promise<string> | undefined;
  private readOnlySocket: Promise<string> | undefined;

  constructor(private readonly opts: ToolHostOptions) {
    super();
  }

  /** Tools registered by the runtime (agent, agent_result), next to the built-in TOOLS. */
  private extra: ToolDef[] = [];

  register(...defs: ToolDef[]): void {
    this.extra.push(...defs.filter((d) => !this.extra.some((e) => e.name === d.name)));
  }

  /** Tool sources that change at runtime (MCP servers connecting, adding or dropping tools). */
  private dynamic: (() => ToolDef[])[] = [];
  addSource(fn: () => ToolDef[]): void {
    this.dynamic.push(fn);
  }

  get tools(): ToolDef[] {
    return [...TOOLS, ...this.extra, ...this.dynamic.flatMap((f) => f())];
  }

  /**
   * Versions of a file the user edited in their editor's diff view before accepting (see
   * src/ide): the approved write/edit writes that version instead of the agent's.
   */
  private editorVersions = new Map<string, string>();
  useEditorVersion(absPath: string, contents: string): void {
    this.editorVersions.set(absPath, contents);
  }

  /** The resolved (real, absolute) paths a call would touch, as approvals and rules see them. */
  pathsFor(name: string, args: unknown): string[] {
    const tool = this.find(name);
    return tool ? (this.subject({...this.context()}, tool, args).paths ?? []) : [];
  }

  private find(name: string): ToolDef | undefined {
    const n = name.replace(/^mcp__rein__/, '');
    return toolByName(n) ?? this.extra.find((t) => t.name === n) ?? this.dynamic.flatMap((f) => f()).find((t) => t.name === n);
  }

  /** Definitions as the model sees them right now (dynamic descriptions resolved). */
  specs(opts: {subagent?: boolean; includeMainOnly?: boolean} = {}): ToolSpec[] {
    return this.tools
      .filter((t) => t.enabled?.() ?? true)
      .filter((t) => !opts.subagent || !t.mainOnly || opts.includeMainOnly)
      .filter((t) => !this.deferred(t.name))
      .map((t) => ({name: t.name, description: t.describe?.() ?? t.description, inputSchema: this.withTodos(t, t.schema?.() ?? t.inputSchema)}))
      .concat(this.experiment('lazy-tools') ? [this.toolIndex(opts)] : []);
  }

  /**
   * lazy-tools: tools a coding task rarely needs stay out of every request (their definitions are
   * ~3k tokens a request); one `tool` entry lists them by name and loads or runs them on demand.
   */
  private static readonly ON_DEMAND = new Set(['skill', 'agent', 'decide', 'mcp_add', 'mcp_list', 'mcp_call', 'mcp_remove', 'web_fetch', 'web_search', 'image_generate', 'recall', 'remember', 'forget', 'sessions_search', 'session_read', 'lsp_install']);

  private deferred(name: string): boolean {
    return this.experiment('lazy-tools') && ToolHost.ON_DEMAND.has(name);
  }

  private onDemand(opts: {subagent?: boolean; includeMainOnly?: boolean} = {}): ToolDef[] {
    return this.tools.filter((t) => ToolHost.ON_DEMAND.has(t.name) && (t.enabled?.() ?? true) && (!opts.subagent || !t.mainOnly || opts.includeMainOnly));
  }

  private toolIndex(opts: {subagent?: boolean; includeMainOnly?: boolean}): ToolSpec {
    const first = (d: string) => (d.split(/(?<=\.)\s|\n/)[0] ?? d).slice(0, 110);
    const list = this.onDemand(opts).map((t) => `${t.name}: ${first(t.describe?.() ?? t.description)}`);
    return {
      name: 'tool',
      description: `More tools, loaded on demand. {name} returns that tool's description and parameters; {name, args} runs it (same approvals as calling it directly).\n${list.join('\n')}`,
      inputSchema: {type: 'object', properties: {name: {type: 'string', description: 'The tool'}, args: {type: 'object', description: "Its arguments; leave out to see what it takes"}}, required: ['name']},
    };
  }

  /** todo-piggyback: the tools that do the work also take the task list, so updating it costs no round trip. */
  private static readonly CARRY_TODOS = ['edit', 'write', 'shell'];

  private withTodos(t: ToolDef, schema: Record<string, unknown>): Record<string, unknown> {
    if (!this.experiment('todo-piggyback') || !ToolHost.CARRY_TODOS.includes(t.name) || !this.find('todo_write')) return schema;
    const props = (schema as {properties?: Record<string, unknown>}).properties ?? {};
    return {
      ...schema,
      properties: {
        ...props,
        todos: {
          type: 'array',
          description: 'Optional: the updated task list (same as todo_write), applied with this call so it costs no extra round trip',
          items: {type: 'object', properties: {content: {type: 'string'}, status: {type: 'string', enum: ['pending', 'in_progress', 'completed']}, activeForm: {type: 'string'}}, required: ['content', 'status']},
        },
      },
    };
  }

  /** The agent was told once that a shell read ran as a tool. */
  private steeredOnce = false;
  /** Untrusted work (an issue from a tracker) always asks, whatever mode the user chose. */
  private modeFor(origin: Origin | undefined): ApprovalMode {
    return origin && this.opts.untrusted?.(origin) ? 'ask' : this.opts.mode();
  }

  /** Per agent (main or a subagent): calls still running, the last one that may change files, and batching counts. */
  private lanes = new Map<string, Lane>();

  /**
   * A model's calls, run in the order it made them. CLIs may send one response's calls at once;
   * reads next to each other still run side by side, but a call that may change something waits for
   * every call before it, and every later call waits for it. So a response can edit files and then
   * run the tests, and get results that match the order it wrote them in.
   */
  callInOrder(name: string, args: unknown, origin?: Origin): Promise<ToolResult> {
    const key = origin?.agentId === undefined ? '' : String(origin.agentId);
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, (lane = {running: new Set(), barrier: Promise.resolve(), lastDone: 0, inResponse: 0, single: 0, nudgeAt: NUDGE_AFTER}));
    const now = Date.now();
    // A call that arrives while others run, or right after one returned, belongs to the same model
    // response: a new response takes the model at least a second to write.
    const sameResponse = lane.running.size > 0 || now - lane.lastDone < SAME_RESPONSE_MS;
    let nudge: string | undefined;
    if (sameResponse) lane.inResponse++;
    else {
      lane.single = lane.inResponse === 1 ? lane.single + 1 : 0;
      lane.inResponse = 1;
      if (lane.single >= lane.nudgeAt && this.experiment('many-calls')) {
        nudge = `[Rein: your last ${lane.single} responses each made a single tool call, and each response re-reads the whole conversation. Put the calls you can already see into one response: the reads, searches and edits you've decided on, and independent commands. They run in the order you write them.]`;
        lane.nudgeAt *= 2; // remind less often each time
        lane.single = 0;
      }
    }
    const reads = this.readsOnly(name, args);
    const start = reads ? lane.barrier : Promise.all([...lane.running]);
    const l = lane;
    // Cleared before the result goes back, so the model's next call counts as a new response.
    const run = start
      .then(() => this.call(name, args, origin))
      .finally(() => {
        l.running.delete(done);
        l.lastDone = Date.now();
      });
    const done: Promise<unknown> = run.then(
      () => {},
      () => {},
    );
    l.running.add(done);
    if (!reads) l.barrier = done;
    return nudge ? run.then((r) => ({...r, text: `${r.text}\n\n${nudge}`})) : run;
  }

  /** Calls that only look: they may run alongside other reads. */
  private readsOnly(name: string, args: unknown): boolean {
    const tool = this.find(name.replace(/^mcp__rein__/, ''));
    if (!tool || tool.name === 'tool' || tool.name === 'ask') return false;
    if (tool.name === 'shell') {
      const a = (args ?? {}) as {command?: unknown; background?: unknown};
      return typeof a.command === 'string' && !a.background && readOnlyCommand(a.command);
    }
    return !tool.mutating;
  }

  async call(name: string, rawArgs: unknown, origin?: Origin): Promise<ToolResult> {
    if (name.replace(/^mcp__rein__/, '') === 'tool' && this.experiment('lazy-tools')) {
      const a = (rawArgs ?? {}) as {name?: unknown; args?: unknown};
      const wanted = typeof a.name === 'string' ? a.name.replace(/^mcp__rein__/, '') : undefined;
      const target = wanted ? this.onDemand({subagent: !!origin}).find((t) => t.name === wanted) : undefined;
      if (!target) return {ok: false, text: `no on-demand tool ${String(a.name)}; the list is in the tool description`};
      if (a.args === undefined) return {ok: true, text: `${target.name}: ${target.describe?.() ?? target.description}\nParameters (JSON Schema): ${JSON.stringify(target.schema?.() ?? target.inputSchema)}`};
      return this.call(target.name, a.args, origin);
    }
    // `cat F`, `grep -rn x src`, `sed -n '10,40p' F`…: run as the built-in tool (tools/steer.ts).
    if (name === 'shell' && this.opts.steerShell?.() !== false) {
      const a = (rawArgs ?? {}) as {command?: unknown; cwd?: unknown; background?: unknown; interactive?: unknown};
      const steered = typeof a.command === 'string' && !a.cwd && !a.background && !a.interactive ? steer(a.command, this.opts.root) : undefined;
      if (steered) {
        const r = await this.call(steered.tool, steered.args, origin);
        if (this.steeredOnce) return r;
        this.steeredOnce = true;
        return {...r, text: `${r.text}\n\n[Rein ran \`${String(a.command).trim().split(/\s+/)[0]}\` as the ${steered.tool} tool: same result, and files count as read for edit. Call ${steered.tool} directly next time.]`};
      }
    }
    let args = rawArgs;
    const tool = this.find(name);
    if (!tool) return {ok: false, text: `unknown tool ${name}`};
    args = this.scoped(tool.name, args);
    let todoNote: string | undefined;
    if (ToolHost.CARRY_TODOS.includes(tool.name) && Array.isArray((args as {todos?: unknown})?.todos)) {
      const {todos, ...rest} = args as {todos: unknown[]};
      args = rest;
      if (this.experiment('todo-piggyback')) {
        const r = await this.call('todo_write', {todos}, origin).catch((err: Error) => ({ok: false, text: err.message}));
        todoNote = r.ok ? '(task list updated)' : `(task list not updated: ${r.text})`;
      }
    }
    if (origin && tool.mainOnly) return {ok: false, text: `${tool.name} is only available to the main agent (subagents can't spawn subagents)`};
    const summary = tool.summarize(args);
    const id = this.nextId++;
    this.emit('activity', {phase: 'start', id, label: tool.label, summary, origin} satisfies ToolActivity);
    let result: ToolResult;
    let approvedBy: ApprovedBy | undefined;
    let judge: string | undefined;
    let warning: string | undefined;
    try {
      const ctx: ToolContext = {...this.context(), origin};
      // A subagent working alongside others gets its own worktree on its first change (see
      // agents/worktrees.ts): from then on its calls run there, with the project's paths retargeted.
      let isolated = false;
      if (origin && this.opts.isolate) {
        const writes = !!tool.mutating && !(tool.name === 'shell' && readOnlyCommand(String((args as any)?.command ?? '')));
        const wt = await this.opts.isolate(origin, writes).catch(() => undefined);
        if (wt) {
          for (const from of new Set([this.opts.root, realRoot(this.opts.root)])) args = retarget(args, from, wt.root);
          ctx.root = wt.root;
          ctx.extraRoots = [...(ctx.extraRoots ?? []), ...wt.writable];
          isolated = true;
        }
      }
      // Permission rules (Claude Code format, .rein/.claude settings): deny blocks outright,
      // allow skips the prompt. Every call is checked — even ones that wouldn't ask.
      const subject = this.subject(ctx, tool, args);
      const fileRules = loadRules(this.opts.root);
      const extra = this.opts.extraRules?.() ?? {allow: [], deny: []};
      const verdict = check({allow: [...fileRules.allow, ...extra.allow], deny: [...fileRules.deny, ...extra.deny]}, subject, (p) => this.pathForms(p));
      if (verdict === 'deny') throw new ToolError(`blocked by a permission rule (deny) in the user's settings; ask the user instead of retrying`);
      // PreToolUse hooks (Claude Code format) may block, approve, or force the prompt.
      const hookInput = {session_id: this.opts.sessionId?.(), tool: tool.name, tool_input: args ?? {}};
      const pre = hasHooks('PreToolUse', this.opts.root) ? await runHooks('PreToolUse', this.opts.root, hookInput) : undefined;
      if (pre?.block) throw new ToolError(`blocked by a PreToolUse hook: ${pre.block}`);
      // Read-only shell commands (ls, git status, brew info, --version…) run without asking, like
      // Claude Code — unless they name paths outside the working directories.
      // A command leaving the sandbox is never "just read-only": it always gets the prompt below.
      const unsandboxed = tool.name === 'shell' && (args as {unsandboxed?: boolean} | undefined)?.unsandboxed === true && (this.opts.sandbox?.() ?? 'off') !== 'off';
      const readOnly = !unsandboxed && tool.name === 'shell' && typeof (args as any)?.command === 'string' && readOnlyCommand((args as any).command) && !this.namesOutside(ctx, (args as any).command);
      // Plan mode: file changes are refused. A command not on the read-only list goes to the
      // decision model ("does this only read?"); if it can't say yes, bypass mode refuses it and the
      // other modes ask the user.
      let planAsk = !!this.opts.planMode?.() && this.checkPlanMode(ctx, tool, args, readOnly);
      if (planAsk && this.opts.readOnlyJudge) {
        const v = await this.opts.readOnlyJudge(String((args as any)?.command ?? '')).catch(() => undefined);
        if (v?.readOnly) {
          planAsk = false;
          approvedBy = 'auto';
          judge = `read-only, ${v.note}`;
        }
      }
      if (planAsk && this.modeFor(origin) === 'bypass')
        throw new ToolError('plan mode is on — this command may change things, so it waits for the plan\'s approval. Use plain read-only commands (one per call, no loops or substitutions) to explore, then call present_plan.');
      if (pre?.allow && !pre.ask) approvedBy = 'hook';
      const suggestion = suggestRule(subject, (p) => this.ruleRel(p));
      const remember = (decision: ApprovalDecision) => {
        if (decision === 'always' && suggestion) addProjectRule(this.opts.root, suggestion);
      };
      // Paths outside the working directories: ask first, like Claude Code ("allow this read
      // outside the working directories?"). Writes there always need an explicit yes.
      const outside = this.outsidePaths(ctx, tool, args);
      if (outside.length && approvedBy === 'hook') ctx.outsideAllowed = outside;
      if (outside.length && !approvedBy) {
        const mode = this.modeFor(origin);
        const sensitive = outside.some(isSensitivePath);
        const req = {tool, args, summary, preview: preview(tool, args), origin, outside, sensitive, suggestion: sensitive ? undefined : suggestion};
        if (verdict === 'allow') approvedBy = 'rule';
        else if (mode === 'bypass' && !sensitive) approvedBy = 'bypass';
        else if (!tool.mutating && this.outsideReadsAllowed && !sensitive) approvedBy = 'session';
        else if (mode === 'auto' && !tool.mutating && !sensitive && this.opts.judge) {
          const verdict = await this.opts.judge(req).catch((err) => ({allow: false, note: `judge failed: ${(err as Error).message}`}));
          judge = verdict.note;
          if (verdict.allow) approvedBy = 'auto';
        }
        if (!approvedBy) {
          const decision = await this.opts.approve(req);
          if (decision === 'deny') throw new ToolError(`the user denied access to ${outside.join(', ')} (outside the project); ask them how to proceed instead of retrying`);
          remember(decision);
          if (decision === 'session' && !sensitive) {
            if (tool.mutating) this.addDirs(outside.map((p) => (existsSync(p) && statSync(p).isDirectory() ? p : path.dirname(p))));
            else this.outsideReadsAllowed = true;
          }
          approvedBy = decision === 'session' ? 'session' : decision === 'always' ? 'rule' : 'user';
        }
        ctx.outsideAllowed = outside;
      }
      // exfilGuard: outside content and private data have both been in this conversation, so anything that
      // can send data to another machine is your call, whatever the mode (only once or deny).
      if (this.opts.exfilGuard?.() && this.untrustedSeen && this.privateSeen && networkCapable(tool.name, args)) {
        const reason = `This conversation has seen outside content (${this.untrustedSeen}) and private data (${this.privateSeen}), and this call can send data to another machine.`;
        const decision = await this.opts.approve({tool, args, summary, preview: preview(tool, args), origin, reason});
        if (decision === 'deny') throw new ToolError("the user declined a network call (exfiltration guard: outside content and private data are both in this conversation); continue without it, or ask them");
        approvedBy = 'user';
      }
      if (tool.mutating && tool.name !== 'shell' && this.inScratch(ctx, tool, args)) approvedBy = 'scratchpad';
      // (After the outside-path check: a read-only command in an outside cwd still asks about access.)
      if (readOnly && !pre?.ask && !approvedBy) approvedBy = 'read-only';
      if (tool.mutating && !approvedBy) {
        const mode = this.modeFor(origin);
        const req = planAsk ? {tool, args, summary, preview: preview(tool, args), origin, planMode: true} : {tool, args, summary, preview: preview(tool, args), origin, suggestion};
        // Leaving the sandbox is always the user's call: no rule, session allowance, judge or bypass covers it.
        const forceAsk = !!pre?.ask || planAsk || unsandboxed || !!tool.askEvenInBypass; // a PreToolUse hook asked for the prompt, plan mode, leaving the sandbox, or installing software
        if (forceAsk) {
          // fall through to the prompt
        } else if (verdict === 'allow') approvedBy = 'rule';
        else if (mode === 'bypass') approvedBy = 'bypass';
        else if (this.sessionAllowed && !tool.alwaysAsk) approvedBy = 'session';
        else if (mode === 'auto' && this.opts.judge && !tool.alwaysAsk) {
          // Never auto-deny: a doubtful verdict (or a judge failure) goes to the user.
          const verdict = await this.opts.judge(req).catch((err) => ({allow: false, note: `judge failed: ${(err as Error).message}`}));
          judge = verdict.note;
          if (verdict.allow) approvedBy = 'auto';
        }
        if (!approvedBy) {
          const decision = await this.opts.approve(req);
          if (decision === 'deny' && planAsk) throw new ToolError('plan mode is on and the user declined this command (it may change things). Stick to read-only exploration, then call present_plan.');
          if (decision === 'deny' && tool.askEvenInBypass) throw new ToolError("not approved (the user declined, or nobody is here to approve it, as in a headless run). Don't retry: tell the user what it would do so they can run it themselves.");
          if (decision === 'deny') throw new ToolError('the user denied this action; ask them how to proceed instead of retrying');
          if (decision === 'session' && !planAsk) this.sessionAllowed = true;
          remember(decision);
          approvedBy = decision === 'session' ? 'session' : decision === 'always' ? 'rule' : 'user';
        }
      }
      // Checkpoint every file this call may change (not scratchpad files) before it runs.
      if (ruleTool(tool.name) === 'edit' && this.opts.checkpoint && approvedBy !== 'scratchpad' && !isolated) {
        for (const p of subject.paths ?? []) await this.opts.checkpoint(p).catch(() => {});
      }
      const edited = (tool.name === 'write' || tool.name === 'edit') && subject.paths?.length === 1 ? this.editorVersions.get(subject.paths[0]!) : undefined;
      if (edited !== undefined) {
        this.editorVersions.delete(subject.paths![0]!);
        result = await toolByName('write')!.run(ctx, {path: subject.paths![0], content: edited});
        if (result.ok) result = {...result, text: `${result.text}\n(The user changed your edit in their editor before accepting it: the file now has their version. Read it again before further edits.)`};
      } else {
        // Files a write/edit/delete touches: their diagnostics before, to report what the change broke.
        const changes = this.opts.diagnostics && ['write', 'edit', 'delete'].includes(tool.name) ? this.filesOf(ctx, tool, args) : [];
        const snapshot = changes.length ? await this.opts.diagnostics!.before(changes, ctx.root).catch(() => undefined) : undefined;
        const repeat = tool.name === 'read' ? this.unchangedRead(ctx, args, origin) : undefined;
        const watched = this.experiment('watchdog') && !origin ? this.filesOf(ctx, tool, args) : undefined;
        const stop = watched && this.watchdog.before(tool.name, args, watched);
        if (stop) throw new ToolError(stop);
        // secretScan: a credential the change would add, before it lands.
        const scan = this.opts.secretScan?.() ?? 'off';
        const secrets = scan !== 'off' && (tool.name === 'write' || tool.name === 'edit') ? findSecrets(addedText(tool.name, args)) : [];
        const file = String((args as {path?: string})?.path ?? (args as {edits?: {path?: string}[]})?.edits?.[0]?.path ?? 'the file');
        if (secrets.length && scan === 'block') throw new ToolError(secretMessage(secrets, file, true));
        // depCheck: packages this change adds (a manifest edit or an install command), vetted before it runs.
        const depMode = this.opts.depCheck?.() ?? 'off';
        let depProblems: string[] = [];
        if (depMode !== 'off') {
          const target = tool.name === 'write' || tool.name === 'edit' ? this.filesOf(ctx, tool, args)[0] : undefined;
          const change = target ? afterEdit(target, args) : undefined;
          const deps = tool.name === 'shell' ? commandDeps(String((args as {command?: string})?.command ?? '')) : target && change ? addedDeps(target, change.before, change.after) : [];
          if (deps.length) depProblems = await checkDeps(deps);
          if (depProblems.length && depMode === 'block') throw new ToolError(depMessage(depProblems, true));
        }
        result = repeat ?? (await tool.run(ctx, args ?? {}));
        if (secrets.length && result.ok) result = {...result, text: `${result.text}\n\n${secretMessage(secrets, file, false)}`};
        if (depProblems.length) {
          result = {...result, text: `${result.text}\n\n${depMessage(depProblems, false)}`};
          warning = `Dependency check: ${depProblems.join('; ')}`;
        }
        const source = untrustedSource(tool.name);
        if (source && result.ok) {
          this.untrustedSeen ??= source;
          const signs = this.opts.injectionScan?.() ? injectionSigns(result.text) : [];
          if (signs.length) {
            result = {...result, text: `${injectionWarning(source, signs)}\n\n${result.text}`};
            warning = `Content from ${source} looks like it tries to instruct the agent (${signs.join(', ')}); it was flagged to the agent as data.`;
          }
        }
        if (!this.privateSeen && result.ok && (tool.name === 'read' || tool.name === 'shell' || tool.name === 'search')) {
          const sensitive = this.filesOf(ctx, tool, args).find(isSensitivePath);
          if (sensitive) this.privateSeen = `a sensitive file, ${path.basename(sensitive)}`;
          else if (findSecrets(result.text).length) this.privateSeen = 'a credential in a tool result';
        }
        const loop = watched && this.watchdog.after(tool.name, args, result.ok, watched);
        if (loop) result = {...result, text: `${result.text}\n\n${loop}`};
        if (!repeat && tool.name === 'read') this.noteRead(ctx, args, result, origin);
        if (tool.name === 'shell') result = this.quietPassing(args, result);
        if (result.ok && snapshot) {
          const note = await this.opts.diagnostics!.after(snapshot).catch(() => undefined);
          if (note) result = {...result, text: `${result.text}\n\n${note}`};
        }
        if (result.ok && tool.name === 'read') for (const f of this.filesOf(ctx, tool, args)) this.opts.diagnostics?.read?.(f, ctx.root);
        if (tool.name === 'shell' && !(args as {background?: boolean})?.background) this.opts.diagnostics?.shell?.(ctx.root);
      }
      if (this.opts.mask) result = {...result, text: this.opts.mask(result.text)};
      // PostToolUse hooks: feedback (exit 2 / decision "block") and context go back to the model.
      if (hasHooks('PostToolUse', this.opts.root)) {
        const post = await runHooks('PostToolUse', this.opts.root, {...hookInput, tool_response: {ok: result.ok, text: result.text.slice(0, 20_000)}});
        const notes = [post.block && `[PostToolUse hook] ${post.block}`, post.context && `[PostToolUse hook context] ${post.context}`].filter(Boolean);
        if (notes.length) result = {...result, text: `${result.text}\n\n${notes.join('\n')}`};
      }
    } catch (err) {
      result = {ok: false, text: err instanceof ToolError ? err.message : `error: ${(err as Error).message}`};
    }
    if (this.opts.mask) result = {...result, text: this.opts.mask(result.text)}; // errors too (and hook notes)
    if (todoNote) result = {...result, text: `${result.text}\n${todoNote}`};
    if (result.ok) {
      const note = this.batchNudge(tool?.name ?? name, args);
      if (note) result = {...result, text: `${result.text}\n\n${note}`};
    }
    if (result.text.length > MAX_RESULT_CHARS) result = {...result, text: result.text.slice(0, MAX_RESULT_CHARS) + '\n… [output truncated]'};
    // A subfolder's own AGENTS.md / CLAUDE.md, the first time the agent works in it (scoped to it).
    if (result.ok) {
      const scoped = this.scopedFor(name, args);
      if (scoped) result = {...result, text: `${result.text}\n\n${scoped}`};
    }
    this.emit('activity', {phase: 'end', id, label: tool.label, summary, ok: result.ok, result: result.text, approvedBy, judge, origin, diff: result.diff, ...(warning ? {warning} : {})} satisfies ToolActivity);
    return {ok: result.ok, text: result.text, ...(result.images?.length ? {images: result.images} : {})}; // the diff is for the user, not the model
  }

  /** exfilGuard: what outside content and what private data this conversation has seen (cleared by /clear). */
  untrustedSeen: string | undefined;
  privateSeen: string | undefined;

  /** The `watchdog` experiment: the main agent repeating a failing command or undoing its own edits. */
  readonly watchdog = new Watchdog();

  private experiment(name: string): boolean {
    return this.opts.experiments?.().includes(name) ?? false;
  }

  private wholeRead(ctx: ToolContext, args: any): string | undefined {
    if (typeof args?.path !== 'string' || args.offset || args.limit || args.pages || Array.isArray(args.paths)) return undefined;
    try {
      return resolvePath(ctx, args.path).real;
    } catch {
      return undefined;
    }
  }

  /**
   * reread-unchanged: reading a whole file again that this model context already read, and that
   * hasn't changed since, returns a one-line note instead of the file. Only within the same native
   * session: after compaction, failover or a model switch the earlier read is gone, so it's re-sent.
   */
  private unchangedRead(ctx: ToolContext, args: any, origin: Origin | undefined): ToolResult | undefined {
    if (!this.experiment('reread-unchanged')) return undefined;
    const file = this.wholeRead(ctx, args);
    const context = this.opts.contextId?.();
    if (!file || !context) return undefined;
    const seen = this.shown.get(`${origin?.agentId ?? 0}|${file}`);
    let st;
    try {
      st = statSync(file);
    } catch {
      return undefined;
    }
    if (!seen || seen.context !== context || seen.mtimeMs !== st.mtimeMs || seen.size !== st.size) return undefined;
    return {ok: true, text: `(${args.path} is unchanged since you read it earlier in this conversation (${seen.lines} lines); it's above. Pass offset/limit to see part of it again.)`};
  }

  private noteRead(ctx: ToolContext, args: any, result: ToolResult, origin: Origin | undefined): void {
    if (!this.experiment('reread-unchanged') || !result.ok || /\n… more lines follow/.test(result.text)) return;
    const file = this.wholeRead(ctx, args);
    const context = this.opts.contextId?.();
    if (!file || !context) return;
    try {
      const st = statSync(file);
      this.shown.set(`${origin?.agentId ?? 0}|${file}`, {context, mtimeMs: st.mtimeMs, size: st.size, lines: result.text.split('\n').length});
    } catch {}
  }

  /**
   * quiet-passing-output: a build or test command that passed (exit 0) returns its last lines, where
   * the summary is, instead of every passing test. Failures always come back in full.
   */
  private quietPassing(args: any, result: ToolResult): ToolResult {
    if (!this.experiment('quiet-passing-output') || !result.ok || args?.background) return result;
    const command = String(args?.command ?? '');
    if (!BUILD_OR_TEST.test(command)) return result;
    const m = /^\[exit 0 after [^\]]*\]\n/.exec(result.text);
    if (!m) return result;
    const lines = result.text.slice(m[0].length).split('\n');
    if (lines.length <= QUIET_KEEP + 10) return result;
    const kept = lines.slice(-QUIET_KEEP);
    return {...result, text: `${m[0]}(passed: ${lines.length - QUIET_KEEP} earlier lines of output left out; the end, with the summary, follows. Rerun with a narrower command if you need them.)\n${kept.join('\n')}`};
  }

  private batchNudge(name: string, args: any): string | undefined {
    const single = (name === 'edit' && !Array.isArray(args?.edits)) || (name === 'read' && !Array.isArray(args?.paths));
    this.streak = single ? {tool: name, n: this.streak.tool === name ? this.streak.n + 1 : 1} : {tool: '', n: 0};
    if (this.streak.n < 2 || this.nudged.has(name)) return undefined;
    this.nudged.add(name);
    return name === 'edit'
      ? '(Several changes to make? Pass them all as `edits` in one edit call, across files too: one round trip instead of one per change.)'
      : '(Several files to read? Pass them all as `paths` in one read call: one round trip instead of one per file.)';
  }

  private scopedFor(name: string, args: any): string | undefined {
    const tool = this.find(name);
    if (!tool?.paths) return undefined;
    const root = realpathSync(this.opts.root);
    const items = [];
    for (const p of tool.paths(args)) {
      let real: string;
      try {
        real = resolvePath(this.context(), p).real;
      } catch {
        continue;
      }
      const dir = existsSync(real) && statSync(real).isDirectory() ? real : path.dirname(real);
      // Another repo added as a working directory (/add-dir, additionalDirectories): its own
      // AGENTS.md / CLAUDE.md too, from its top, the first time the agent works there.
      const inside = (r: string) => dir === r || dir.startsWith(r + path.sep);
      const extra = inside(root) ? undefined : this.extraWorkingDirs().map((d) => {
        try {
          return realpathSync(d);
        } catch {
          return d;
        }
      }).find(inside);
      items.push(...scopedInstructions(extra ? path.dirname(extra) : root, dir, this.deliveredInstructions));
    }
    return items.length ? renderScoped(items) : undefined;
  }

  /** Plan mode: only reading. Scratchpad notes and read-only shell commands are fine. */
  /** Plan mode: throws for file changes; returns true when a shell command needs the user's OK. */
  private checkPlanMode(ctx: ToolContext, tool: ToolDef, args: any, readOnly: boolean): boolean {
    if (tool.name === 'shell') return !readOnly && !readOnlyCommand(String(args?.command ?? ''));
    if (tool.mutating && !this.inScratch(ctx, tool, args)) throw new ToolError('plan mode is on — nothing can be changed until the user approves your plan. Keep exploring read-only, then call present_plan.');
    return false;
  }

  /** Does a command name an absolute or ~ path outside the working directories? */
  private namesOutside(ctx: ToolContext, command: string): boolean {
    for (const m of command.matchAll(/(?:^|[\s='"])((?:~|\/)[^\s'";|&)]*)/g)) {
      const raw = m[1]!;
      if (/^\/dev\/(null|stdin|stdout|stderr)$/.test(raw)) continue;
      const abs = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
      try {
        if (!resolvePath(ctx, abs).inside) return true;
      } catch {
        return true;
      }
    }
    return /(^|[\s/])\.\.(\/|\s|$)/.test(command);
  }

  /** What permission rules look at for this call: the command, the paths it touches, the URL. */
  private subject(ctx: ToolContext, tool: ToolDef, args: any): Subject {
    const paths: string[] = [];
    for (const p of tool.paths?.(args) ?? []) {
      try {
        paths.push(resolvePath(ctx, p).real);
      } catch {}
    }
    return {
      tool: tool.name,
      command: tool.name === 'shell' && typeof args?.command === 'string' ? args.command : undefined,
      paths: paths.length ? paths : undefined,
      url: typeof args?.url === 'string' ? args.url : undefined,
    };
  }

  /** A path as rules may name it: project-relative and absolute (rules may use ~/ too). */
  private pathForms(abs: string): string[] {
    return [path.relative(realpathSync(this.opts.root), abs) || '.', abs];
  }

  /** How a suggested rule names a path: project-relative inside the project, else ~/… or absolute. */
  private ruleRel(abs: string): string {
    const rel = path.relative(realpathSync(this.opts.root), abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
    const home = os.homedir();
    return toPosix(abs.startsWith(home + path.sep) ? `~${abs.slice(home.length)}` : abs);
  }

  /** "Allow all changes for this session" from outside the approval prompt (plan approval). */
  allowSession(): void {
    this.sessionAllowed = true;
  }

  /** Add working directories for this session (must exist); returns the ones added. */
  addDirs(dirs: string[]): string[] {
    const added: string[] = [];
    for (const d of dirs) {
      const expanded = d === '~' ? os.homedir() : d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : d;
      const abs = path.resolve(this.opts.root, expanded);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new ToolError(`${d} is not a directory`);
      const real = realpathSync(abs);
      if (!this.addedDirs.includes(real)) {
        this.addedDirs.push(real);
        added.push(real);
      }
    }
    return added;
  }

  /** With a scope set, list and search without a path, and shell without a cwd, start in the scope. */
  private scoped(name: string, args: unknown): unknown {
    const scope = this.opts.scope?.();
    if (!scope || (name !== 'list' && name !== 'search' && name !== 'shell')) return args;
    const a = (args ?? {}) as Record<string, unknown>;
    const key = name === 'shell' ? 'cwd' : 'path';
    if (a[key] !== undefined && a[key] !== '') return args;
    return {...a, [key]: toPosix(path.relative(this.opts.root, scope)) || '.'};
  }

  /** Directories the user added (config additionalDirectories + /add-dir / --add-dir), resolved. */
  extraWorkingDirs(): string[] {
    const config = (this.opts.configDirs?.() ?? []).map((d) => (d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : path.resolve(this.opts.root, d)));
    return [...new Set([...config.filter(existsSync).map((d) => realpathSync(d)), ...this.addedDirs])];
  }

  /** Every working directory: project root, scratchpad, global skills, config and session additions. */
  workingDirs(): string[] {
    return workingDirs(this.context());
  }

  /** A tool call's files, resolved (inside the working directories only). */
  private filesOf(ctx: ToolContext, tool: ToolDef, args: any): string[] {
    const out: string[] = [];
    for (const p of tool.paths?.(args) ?? []) {
      try {
        const r = resolvePath(ctx, p);
        if (r.inside) out.push(r.real);
      } catch {}
    }
    return out;
  }

  private outsidePaths(ctx: ToolContext, tool: ToolDef, args: any): string[] {
    const out: string[] = [];
    for (const p of tool.paths?.(args) ?? []) {
      try {
        const r = resolvePath(ctx, p);
        if (!r.inside && !out.includes(r.real)) out.push(r.real);
      } catch {
        // Invalid path: the tool itself reports it.
      }
    }
    return out;
  }

  private context(): ToolContext {
    const scratch = this.opts.scratch?.();
    if (scratch) mkdirSync(scratch, {recursive: true});
    // Global skills live outside the project; /skill:create and /skill:edit need to reach them.
    const globalSkills = skillDirs(this.opts.root).global;
    mkdirSync(globalSkills, {recursive: true});
    const config = (this.opts.configDirs?.() ?? []).map((d) => (d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : d));
    return {
      root: this.opts.root,
      scratch,
      reads: this.reads,
      compactLines: this.experiment('compact-read'),
      outlineReads: this.experiment('outline-reads'),
      shellCap: this.experiment('shell-cap'),
      extraRoots: [...(scratch ? [scratch] : []), globalSkills, ...config, ...this.addedDirs],
      shells: this.shells,
      shellMaxMs: this.opts.shellMaxMs?.(),
      sandbox: this.opts.sandbox?.(),
      sessionId: this.opts.sessionId?.(),
    };
  }

  /** File-tool target inside the scratchpad (not the project) → no approval needed. */
  private inScratch(ctx: ToolContext, tool: ToolDef, args: any): boolean {
    const scratch = this.opts.scratch?.();
    if (!scratch) return false;
    if (typeof args?.path !== 'string') return !!tool.defaultsToScratch; // e.g. image_generate without a path
    try {
      const real = resolveInRoot(ctx, args.path);
      const root = realpathSync(scratch);
      return real === root || real.startsWith(root + path.sep);
    } catch {
      return false;
    }
  }

  /**
   * Read-only view for forks (/btw): same tool list (forked histories reference them), but only
   * non-mutating tools run, without approvals or transcript activity.
   */
  readOnly(): {call(name: string, args: unknown): Promise<ToolResult>} {
    return {
      call: async (name, args) => {
        const tool = this.find(name);
        if (!tool || tool.mutating || tool.mainOnly) return {ok: false, text: `${name} is not available while answering a side question`};
        try {
          return await tool.run(this.context(), args ?? {});
        } catch (err) {
          return {ok: false, text: err instanceof ToolError ? err.message : `error: ${(err as Error).message}`};
        }
      },
    };
  }

  /** Unix socket for the Claude MCP proxy: newline JSON `{id, method:'list'|'call', name?, args?}`. */
  listen(): Promise<string> {
    return (this.mainSocket ??= this.serve((name, args) => this.callInOrder(name, args)));
  }

  /** A subagent's own socket (Claude MCP): its calls are tagged with `origin`. Close it when done. */
  async listenFor(origin: Origin): Promise<{socket: string; close(): void}> {
    const socket = await this.serve((name, args) => this.callInOrder(name, args, origin));
    return {
      socket,
      close: () => {
        const i = this.sockets.indexOf(socket);
        if (i >= 0) {
          this.servers[i]?.close();
          this.servers.splice(i, 1);
          this.sockets.splice(i, 1);
        }
        if (existsSync(socket)) rmSync(socket, {force: true});
      },
    };
  }

  /** Socket for forks (/btw): read-only tools, no approvals, no transcript activity. */
  listenReadOnly(): Promise<string> {
    const ro = this.readOnly();
    return (this.readOnlySocket ??= this.serve((name, args) => ro.call(name, args)));
  }

  private async serve(call: (name: string, args: unknown) => Promise<ToolResult>): Promise<string> {
    // A unix socket (paths are limited to ~104 bytes on macOS: short, in the per-user tmpdir), or a
    // named pipe on Windows.
    const sock = ipcPath(`rein-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    if (!isWindows && existsSync(sock)) rmSync(sock);
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          void this.handle(line, call).then((reply) => conn.write(JSON.stringify(reply) + '\n'));
        }
      });
      conn.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, () => resolve());
    });
    this.servers.push(server);
    this.sockets.push(sock);
    if (this.sockets.length === 1) process.once('exit', () => this.close());
    return sock;
  }

  private async handle(line: string, call: (name: string, args: unknown) => Promise<ToolResult>): Promise<unknown> {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return {error: 'bad json'};
    }
    if (msg.method === 'list') return {id: msg.id, tools: this.specs({includeMainOnly: true})};
    if (msg.method === 'call') return {id: msg.id, ...(await call(String(msg.name), msg.args))};
    return {id: msg.id, error: `unknown method ${msg.method}`};
  }

  close(): void {
    this.shells.killAll();
    for (const s of this.servers) s.close();
    if (!isWindows) for (const sock of this.sockets) if (existsSync(sock)) rmSync(sock, {force: true});
    this.servers = [];
    this.sockets = [];
    this.mainSocket = this.readOnlySocket = undefined;
  }
}

function preview(tool: ToolDef, args: any): string {
  const clip = (s: unknown, n = 600) => {
    const t = String(s ?? '');
    return t.length > n ? t.slice(0, n) + `\n… (${t.length - n} more chars)` : t;
  };
  if (tool.name === 'write') return clip(args?.content);
  if (tool.name === 'edit' && Array.isArray(args?.edits)) {
    return clip(args.edits.map((e: any) => `${e?.path ?? args?.path ?? ''}\n- ${clip(e?.old_string, 200).replace(/\n/g, '\n- ')}\n+ ${clip(e?.new_string, 200).replace(/\n/g, '\n+ ')}`).join('\n'), 2000);
  }
  if (tool.name === 'edit') return `- ${clip(args?.old_string, 300).replace(/\n/g, '\n- ')}\n+ ${clip(args?.new_string, 300).replace(/\n/g, '\n+ ')}`;
  if (tool.name === 'delete') return args?.recursive ? 'Deletes the directory and everything in it.' : '';
  if (tool.name === 'mcp_add') {
    return args?.url
      ? `Connect to MCP server "${args?.name}" at ${args.url}${args.headers ? ` (headers: ${Object.keys(args.headers).join(', ')})` : ''}`
      : `Run MCP server "${args?.name}":\n$ ${[args?.command, ...(args?.args ?? [])].join(' ')}${args?.env ? `\n(env: ${Object.keys(args.env).join(', ')})` : ''}\nsaved to ${args?.scope === 'user' ? '~/.rein/mcp.json' : '.mcp.json'}`;
  }
  if (tool.name === 'shell') return `${args?.background ? 'background ' : ''}$ ${clip(args?.command, 800)}${args?.cwd ? `\n(in ${args.cwd})` : ''}`;
  return '';
}

/** How `claude` should launch the MCP proxy (compiled JS, or via tsx when running from source). */
export function mcpProxyCommand(): {command: string; args: string[]} {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.ts')) {
    const tsx = path.resolve(path.dirname(here), '../../node_modules/.bin/tsx');
    return {command: tsx, args: [path.join(path.dirname(here), 'mcpProxy.ts')]};
  }
  return {command: process.execPath, args: [path.join(path.dirname(here), 'mcpProxy.js')]};
}

const HOME = os.homedir();
/** Credentials and secrets: always asked about individually, even in bypass mode. */
const SENSITIVE = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh', '.netrc', '.npmrc', '.git-credentials', '.pypirc', 'Library/Keychains', '.claude', '.claude.json', '.codex', '.rein/accounts', '.rein/accounts.json', '.rein/secrets'].map((p) => path.join(HOME, p));

export function isSensitivePath(real: string): boolean {
  // Rein's own secrets folder (the vault, the Jev key), wherever the data folder is (REIN_HOME, XDG).
  const secrets = secretsDir();
  if ([...SENSITIVE, secrets].some((p) => real === p || real.startsWith(p + path.sep))) return true;
  return /(^|\/)\.env(\.[\w.-]+)?$/.test(real) || /\.(pem|key|p12|pfx|keychain)$/i.test(real);
}
