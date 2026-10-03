import {EventEmitter} from 'node:events';
import {existsSync, mkdirSync, realpathSync, rmSync, statSync} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveInRoot, resolvePath, ToolError, workingDirs, type Origin, type ToolContext, type ToolResult} from './fs.js';
import {TOOLS, toolByName, type ToolDef} from './registry.js';
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
};
export type ApprovalDecision = 'once' | 'session' | 'deny';
export type ApprovalMode = 'ask' | 'auto' | 'bypass';
/** How a file change got approved (shown in the transcript). */
export type ApprovedBy = 'user' | 'session' | 'auto' | 'bypass' | 'scratchpad';
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

  get tools(): ToolDef[] {
    return [...TOOLS, ...this.extra];
  }

  private find(name: string): ToolDef | undefined {
    const n = name.replace(/^mcp__rein__/, '');
    return toolByName(n) ?? this.extra.find((t) => t.name === n);
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
      // Paths outside the working directories: ask first, like Claude Code ("allow this read
      // outside the working directories?"). Writes there always need an explicit yes.
      const outside = this.outsidePaths(ctx, tool, args);
      if (outside.length) {
        const mode = this.opts.mode();
        const sensitive = outside.some(isSensitivePath);
        const req = {tool, args, summary, preview: preview(tool, args), origin, outside, sensitive};
        if (mode === 'bypass' && !sensitive) approvedBy = 'bypass';
        else if (!tool.mutating && this.outsideReadsAllowed && !sensitive) approvedBy = 'session';
        else if (mode === 'auto' && !tool.mutating && !sensitive && this.opts.judge) {
          const verdict = await this.opts.judge(req).catch((err) => ({allow: false, note: `judge failed: ${(err as Error).message}`}));
          judge = verdict.note;
          if (verdict.allow) approvedBy = 'auto';
        }
        if (!approvedBy) {
          const decision = await this.opts.approve(req);
          if (decision === 'deny') throw new ToolError(`the user denied access to ${outside.join(', ')} (outside the project); ask them how to proceed instead of retrying`);
          if (decision === 'session' && !sensitive) {
            if (tool.mutating) this.addDirs(outside.map((p) => (existsSync(p) && statSync(p).isDirectory() ? p : path.dirname(p))));
            else this.outsideReadsAllowed = true;
          }
          approvedBy = decision === 'session' ? 'session' : 'user';
        }
        ctx.outsideAllowed = outside;
      }
      if (tool.mutating && tool.name !== 'shell' && this.inScratch(ctx, tool, args)) approvedBy = 'scratchpad';
      if (tool.mutating && !approvedBy) {
        const mode = this.opts.mode();
        const req = {tool, args, summary, preview: preview(tool, args), origin};
        if (mode === 'bypass') approvedBy = 'bypass';
        else if (this.sessionAllowed) approvedBy = 'session';
        else if (mode === 'auto' && this.opts.judge) {
          // Never auto-deny: a doubtful verdict (or a judge failure) goes to the user.
          const verdict = await this.opts.judge(req).catch((err) => ({allow: false, note: `judge failed: ${(err as Error).message}`}));
          judge = verdict.note;
          if (verdict.allow) approvedBy = 'auto';
        }
        if (!approvedBy) {
          const decision = await this.opts.approve(req);
          if (decision === 'deny') throw new ToolError('the user denied this action; ask them how to proceed instead of retrying');
          if (decision === 'session') this.sessionAllowed = true;
          approvedBy = decision === 'session' ? 'session' : 'user';
        }
      }
      result = await tool.run(ctx, args ?? {});
    } catch (err) {
      result = {ok: false, text: err instanceof ToolError ? err.message : `error: ${(err as Error).message}`};
    }
    if (result.text.length > MAX_RESULT_CHARS) result = {...result, text: result.text.slice(0, MAX_RESULT_CHARS) + '\n… [output truncated]'};
    this.emit('activity', {phase: 'end', id, label: tool.label, summary, ok: result.ok, result: result.text, approvedBy, judge, origin, diff: result.diff} satisfies ToolActivity);
    return {ok: result.ok, text: result.text}; // the diff is for the user, not the model
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
    // Socket paths are limited to ~104 bytes on macOS: keep it short, in the per-user tmpdir.
    const sock = path.join(os.tmpdir(), `rein-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
    if (existsSync(sock)) rmSync(sock);
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
    for (const sock of this.sockets) if (existsSync(sock)) rmSync(sock, {force: true});
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
