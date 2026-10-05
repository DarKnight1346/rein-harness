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
import {readOnlyCommand} from './plan.js';
import {steer} from './steer.js';
import {ipcPath, isWindows} from '../util/platform.js';
import {ShellManager} from './shells.js';
import type {DiffLine} from './diff.js';
import {skillDirs} from '../skills/index.js';

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
};
export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';
export type ApprovalMode = 'ask' | 'auto' | 'bypass';
/** How a file change got approved (shown in the transcript). */
export type ApprovedBy = 'user' | 'session' | 'auto' | 'bypass' | 'scratchpad' | 'rule' | 'hook' | 'read-only';
export type ToolActivity =
  | {phase: 'start'; id: number; label: string; summary: string; origin?: Origin}
  | {phase: 'end'; id: number; label: string; summary: string; ok: boolean; result: string; approvedBy?: ApprovedBy; judge?: string; origin?: Origin; diff?: DiffLine[]};

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
  /** Extra rules for this run only (headless --allowedTools / --disallowedTools). */
  extraRules?: () => Rules;
  /** Plan mode: file changes and non-read-only commands are refused until the plan is approved. */
  /** Plan mode: does this command only read? (decision model) — lets unlisted queries run. */
  readOnlyJudge?: (command: string) => Promise<{readOnly: boolean; note: string}>;
  planMode?: () => boolean;
  /** Save a file's state before a tool changes it (checkpoints for /rewind). */
  checkpoint?: (file: string) => Promise<void>;
  /** Run simple shell reads/searches (cat, grep, sed -n…) as the built-in tools (default on). */
  steerShell?: () => boolean;
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
      .map((t) => ({name: t.name, description: t.describe?.() ?? t.description, inputSchema: t.schema?.() ?? t.inputSchema}));
  }

  /** The agent was told once that a shell read ran as a tool. */
  private steeredOnce = false;

  async call(name: string, rawArgs: unknown, origin?: Origin): Promise<ToolResult> {
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
    if (origin && tool.mainOnly) return {ok: false, text: `${tool.name} is only available to the main agent (subagents can't spawn subagents)`};
    const summary = tool.summarize(args);
    const id = this.nextId++;
    this.emit('activity', {phase: 'start', id, label: tool.label, summary, origin} satisfies ToolActivity);
    let result: ToolResult;
    let approvedBy: ApprovedBy | undefined;
    let judge: string | undefined;
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
      if (planAsk && this.opts.mode() === 'bypass')
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
        const mode = this.opts.mode();
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
      if (tool.mutating && tool.name !== 'shell' && this.inScratch(ctx, tool, args)) approvedBy = 'scratchpad';
      // (After the outside-path check: a read-only command in an outside cwd still asks about access.)
      if (readOnly && !pre?.ask && !approvedBy) approvedBy = 'read-only';
      if (tool.mutating && !approvedBy) {
        const mode = this.opts.mode();
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
        result = await tool.run(ctx, args ?? {});
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
    if (result.text.length > MAX_RESULT_CHARS) result = {...result, text: result.text.slice(0, MAX_RESULT_CHARS) + '\n… [output truncated]'};
    // A subfolder's own AGENTS.md / CLAUDE.md, the first time the agent works in it (scoped to it).
    if (result.ok) {
      const scoped = this.scopedFor(name, args);
      if (scoped) result = {...result, text: `${result.text}\n\n${scoped}`};
    }
    this.emit('activity', {phase: 'end', id, label: tool.label, summary, ok: result.ok, result: result.text, approvedBy, judge, origin, diff: result.diff} satisfies ToolActivity);
    return {ok: result.ok, text: result.text, ...(result.images?.length ? {images: result.images} : {})}; // the diff is for the user, not the model
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
      items.push(...scopedInstructions(root, dir, this.deliveredInstructions));
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
    return (this.mainSocket ??= this.serve((name, args) => this.call(name, args)));
  }

  /** A subagent's own socket (Claude MCP): its calls are tagged with `origin`. Close it when done. */
  async listenFor(origin: Origin): Promise<{socket: string; close(): void}> {
    const socket = await this.serve((name, args) => this.call(name, args, origin));
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
