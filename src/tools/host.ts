import {EventEmitter} from 'node:events';
import {existsSync, mkdirSync, realpathSync, rmSync, statSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveInRoot, resolvePath, toPosix, ToolError, workingDirs, type FileStamp, type Origin, type ToolContext, type ToolResult} from './fs.js';
import {TOOLS, toolByName, type ToolDef} from './registry.js';
import {addProjectRule, check, loadRules, ruleTool, suggestRule, type Rules, type Subject} from './permissions.js';
import {hasHooks, runHooks} from '../hooks.js';
import {renderScoped, scopedInstructions} from '../session/prompt.js';
import {readOnlyCommand} from './plan.js';
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
};
export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';
export type ApprovalMode = 'ask' | 'auto' | 'bypass';
/** How a file change got approved (shown in the transcript). */
export type ApprovedBy = 'user' | 'session' | 'auto' | 'bypass' | 'scratchpad' | 'rule' | 'hook';
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
  /** Foreground shell cap in ms (0 = none), read per call so /configure applies at once. */
  shellMaxMs?: () => number;
  /** `auto` mode: the decision model's verdict; `ask` falls through to the user. */
  judge?: (req: ApprovalRequest) => Promise<{allow: boolean; note: string}>;
  /** Extra working directories from config (`additionalDirectories`). */
  configDirs?: () => string[];
  /** Extra rules for this run only (headless --allowedTools / --disallowedTools). */
  extraRules?: () => Rules;
  /** Plan mode: file changes and non-read-only commands are refused until the plan is approved. */
  planMode?: () => boolean;
  /** Save a file's state before a tool changes it (checkpoints for /rewind). */
  checkpoint?: (file: string) => Promise<void>;
};

const MAX_RESULT_CHARS = 60_000;

/**
 * Runs Rein's tools for whichever provider is chatting: Claude reaches it through the MCP proxy
 * over a unix socket, Codex calls `call()` in-process. Emits `activity` for the transcript.
 */
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

  async call(name: string, args: unknown, origin?: Origin): Promise<ToolResult> {
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
      if (this.opts.planMode?.()) this.checkPlanMode(ctx, tool, args);
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
      if (tool.mutating && !approvedBy) {
        const mode = this.opts.mode();
        const req = {tool, args, summary, preview: preview(tool, args), origin, suggestion};
        const forceAsk = !!pre?.ask; // a PreToolUse hook asked for the prompt
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
          if (decision === 'deny') throw new ToolError('the user denied this action; ask them how to proceed instead of retrying');
          if (decision === 'session') this.sessionAllowed = true;
          remember(decision);
          approvedBy = decision === 'session' ? 'session' : decision === 'always' ? 'rule' : 'user';
        }
      }
      // Checkpoint every file this call may change (not scratchpad files) before it runs.
      if (ruleTool(tool.name) === 'edit' && this.opts.checkpoint && approvedBy !== 'scratchpad') {
        for (const p of subject.paths ?? []) await this.opts.checkpoint(p).catch(() => {});
      }
      result = await tool.run(ctx, args ?? {});
      // PostToolUse hooks: feedback (exit 2 / decision "block") and context go back to the model.
      if (hasHooks('PostToolUse', this.opts.root)) {
        const post = await runHooks('PostToolUse', this.opts.root, {...hookInput, tool_response: {ok: result.ok, text: result.text.slice(0, 20_000)}});
        const notes = [post.block && `[PostToolUse hook] ${post.block}`, post.context && `[PostToolUse hook context] ${post.context}`].filter(Boolean);
        if (notes.length) result = {...result, text: `${result.text}\n\n${notes.join('\n')}`};
      }
    } catch (err) {
      result = {ok: false, text: err instanceof ToolError ? err.message : `error: ${(err as Error).message}`};
    }
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
  private checkPlanMode(ctx: ToolContext, tool: ToolDef, args: any): void {
    const blocked = 'plan mode is on — nothing can be changed until the user approves your plan. Keep exploring read-only, then call present_plan.';
    if (tool.name === 'shell') {
      if (!readOnlyCommand(String(args?.command ?? ''))) throw new ToolError(`${blocked} (only read-only commands like ls, grep, git status/log/diff run now)`);
      return;
    }
    if (tool.mutating && !this.inScratch(ctx, tool, args)) throw new ToolError(blocked);
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
const SENSITIVE = ['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh', '.netrc', '.npmrc', '.git-credentials', '.pypirc', 'Library/Keychains', '.claude', '.claude.json', '.codex', '.rein/accounts', '.rein/accounts.json'].map((p) => path.join(HOME, p));

export function isSensitivePath(real: string): boolean {
  if (SENSITIVE.some((p) => real === p || real.startsWith(p + path.sep))) return true;
  return /(^|\/)\.env(\.[\w.-]+)?$/.test(real) || /\.(pem|key|p12|pfx|keychain)$/i.test(real);
}
