import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {deleteTool, editTool, listTool, readManyTool, readTool, resolveInRoot, searchTool, ToolError, writeTool, type ToolContext, type ToolResult} from './fs.js';
import {DEFAULT_TIMEOUT_MS, shellStatusText} from './shells.js';
import {shellFor} from '../util/platform.js';
import {sessionRead, sessionsSearch} from './sessions.js';
import {denialNote, type SandboxSpec} from './sandbox.js';

export type ToolDef = {
  name: string;
  /** Shown in the transcript: `Edit(src/x.ts)`. */
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Changes files or runs commands → goes through approval (ask / auto / bypass). */
  mutating: boolean;
  run(ctx: ToolContext, args: any): Promise<ToolResult>;
  /** Short argument summary for the transcript and approval prompt. */
  summarize(args: any): string;
  /** Dynamic description / schema (e.g. the agent tool lists the models signed in right now). */
  describe?(): string;
  schema?(): Record<string, unknown>;
  /** Only the main agent may call it (subagents can't spawn subagents). */
  mainOnly?: boolean;
  /** Hidden from models when false (e.g. advisor while it's off). */
  enabled?(): boolean;
  /** Always ask the user (no auto-approval, no "allow for the session"); rules and bypass still apply. */
  alwaysAsk?: boolean;
  /** Ask even in bypass mode (installing software on the user's machine). */
  askEvenInBypass?: boolean;
  /** A mutating tool that writes into the session scratchpad when no path is given (no approval then). */
  defaultsToScratch?: boolean;
  /** Paths the call touches; any outside the working directories needs the user's approval first. */
  paths?(args: any): string[];
};

const str = (description: string) => ({type: 'string', description});

/** Rein's own tools, exposed identically to every provider (Claude via MCP, Codex as dynamic tools). */
export const TOOLS: ToolDef[] = [
  {
    name: 'read',
    paths: (args) => [args?.path, ...(Array.isArray(args?.paths) ? args.paths : [])].filter((x): x is string => typeof x === 'string'),
    label: 'Read',
    description:
      'Read a file in the project. Returns lines prefixed with their 1-based line number and a tab (like `cat -n`); the prefix is not part of the file. Use offset/limit for large files. Reading a directory lists its entries. Images (PNG/JPEG/GIF/WebP) are shown to you as images; PDFs return their text page by page (use pages, e.g. "3-8", for long ones). To read several files, pass them all as `paths` in one call (up to 20, each shown under its path) instead of one read per file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('File path, relative to the project root'),
        paths: {type: 'array', items: {type: 'string'}, description: 'Several files to read in one call, instead of path'},
        offset: {type: 'integer', description: 'First line to read (1-based)'},
        limit: {type: 'integer', description: 'Max lines (default 2000)'},
        pages: str('PDF pages to read, e.g. "1-5" (max 20 per read)'),
        full: {type: 'boolean', description: 'Read a long file whole even when only its outline would be shown'},
      },
    },
    mutating: false,
    run: (ctx, a) => (Array.isArray(a?.paths) ? readManyTool(ctx, a) : readTool(ctx, a)),
    summarize: (a) => (Array.isArray(a?.paths) ? `${a.paths.length} files: ${a.paths.slice(0, 3).join(', ')}${a.paths.length > 3 ? '…' : ''}` : `${a?.path ?? ''}${a?.offset ? `:${a.offset}` : ''}`),
  },
  {
    name: 'list',
    paths: (args) => [args?.path ?? '.'].filter((x): x is string => typeof x === 'string'),
    label: 'List',
    description:
      'List files and folders in a project directory as a tree (folders first, files with sizes). depth (1–5, default 1) recurses; hidden entries and .git/node_modules/dist/build are skipped unless all: true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Directory, relative to the project root (default: root)'),
        depth: {type: 'integer', description: 'Levels to descend (1–5, default 1)'},
        all: {type: 'boolean', description: 'Include hidden entries and heavy folders'},
        workspace: {type: 'boolean', description: 'In a workspace: list every repo (path inside each), as one tree'},
      },
    },
    mutating: false,
    run: listTool,
    summarize: (a) => `${a?.path ?? '.'}${a?.depth > 1 ? ` depth ${a.depth}` : ''}`,
  },
  {
    name: 'write',
    paths: (args) => [args?.path].filter((x): x is string => typeof x === 'string'),
    label: 'Write',
    description: 'Create a file or overwrite it entirely with `content`. Creates parent directories. Prefer `edit` for changes to existing files.',
    inputSchema: {type: 'object', properties: {path: str('File path, relative to the project root'), content: str('Full file content')}, required: ['path', 'content']},
    mutating: true,
    run: writeTool,
    summarize: (a) => String(a?.path ?? ''),
  },
  {
    name: 'edit',
    // Every file the call changes: permission rules, approvals, checkpoints and the code check see all of them.
    paths: (args) => [...new Set([args?.path, ...(Array.isArray(args?.edits) ? args.edits.map((e: any) => e?.path ?? args?.path) : [])].filter((x): x is string => typeof x === 'string'))],
    label: 'Edit',
    description:
      'Replace an exact string in a file. `old_string` must match the file exactly (whitespace included, without read line-number prefixes) and be unique unless `replace_all` is true; include surrounding lines to make it unique. Read the file first. To make several changes (in one file or across files), pass them all as `edits` in one call instead of calling edit once per change: they apply in order, and if any doesn\'t match, nothing is written.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('File path, relative to the project root (for edits: the default for entries without a path)'),
        old_string: str('Exact text to replace'),
        new_string: str('Replacement text'),
        replace_all: {type: 'boolean', description: 'Replace every occurrence (default false)'},
        edits: {
          type: 'array',
          description: 'Several replacements in one call, instead of old_string/new_string',
          items: {
            type: 'object',
            properties: {path: str('File path (defaults to the top-level path)'), old_string: str('Exact text to replace'), new_string: str('Replacement text'), replace_all: {type: 'boolean'}},
            required: ['old_string', 'new_string'],
          },
        },
      },
    },
    mutating: true,
    run: editTool,
    summarize: (a) => {
      const files = Array.isArray(a?.edits) ? [...new Set(a.edits.map((e: any) => e?.path ?? a?.path))] : [a?.path];
      return files.length > 1 ? `${files.length} files: ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}` : `${files[0] ?? ''}${Array.isArray(a?.edits) && a.edits.length > 1 ? ` (${a.edits.length} edits)` : ''}`;
    },
  },
  {
    name: 'delete',
    paths: (args) => [args?.path].filter((x): x is string => typeof x === 'string'),
    label: 'Delete',
    description: 'Delete a file, or a directory (non-empty directories require recursive: true).',
    inputSchema: {type: 'object', properties: {path: str('Path, relative to the project root'), recursive: {type: 'boolean', description: 'Allow deleting a non-empty directory'}}, required: ['path']},
    mutating: true,
    run: deleteTool,
    summarize: (a) => `${a?.path ?? ''}${a?.recursive ? ' (recursive)' : ''}`,
  },
  {
    name: 'search',
    paths: (args) => [args?.path ?? '.'].filter((x): x is string => typeof x === 'string'),
    label: 'Search',
    description:
      'Search the project. Default: regex over file contents, returning `path:line:text` (respects .gitignore). With files_only: regex over file paths. Narrow with `path` (a directory or file) and `glob` (e.g. "*.ts", "src/**/*.tsx").',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: str('Regular expression'),
        path: str('Directory or file to search (default: project root)'),
        glob: str('Only files matching this glob'),
        files_only: {type: 'boolean', description: 'Match file paths instead of contents'},
        case_insensitive: {type: 'boolean'},
        workspace: {type: 'boolean', description: 'In a workspace: search every repo (path inside each); results are grouped by repo with paths you can read as they are'},
      },
      required: ['pattern'],
    },
    mutating: false,
    run: searchTool,
    summarize: (a) => `${a?.pattern ?? ''}${a?.path ? ` in ${a.path}` : ''}${a?.glob ? ` (${a.glob})` : ''}`,
  },
  {
    name: 'shell',
    paths: (args) => [args?.cwd ?? '.'].filter((x): x is string => typeof x === 'string'),
    label: 'Shell',
    description:
      `Run a shell command in the project (${shellFor('').kind === 'powershell' ? 'PowerShell' : `${path.basename(shellFor('').file)} -c`}). Foreground (default) waits and returns the output and exit code; ` +
      `the user watches it live. Timeout ${DEFAULT_TIMEOUT_MS / 1000}s by default; raise it with timeout_ms for long builds/tests (capped by the user's limit, 120 min by default). ` +
      'Use background: true for long-running processes (dev servers, watchers): it returns an id at once; read output with shell_logs and stop it with shell_kill. ' +
      'Commands get no terminal by default: prefer non-interactive flags (--yes, -y, --no-input). When a command really needs a terminal or asks questions only a person can answer (a login, a passphrase, an installer with no flag for its choices, git rebase -i), set interactive: true: it runs in a terminal, and if it waits for input the user answers it in their terminal, then the output comes back to you. ' +
      "Commands run in Rein's OS sandbox unless the user turned it off: writes only inside the project, its working directories, the scratchpad, temp folders and package caches (git hooks/config and agent/editor settings stay read-only; strict mode also blocks the network). " +
      'If a command genuinely needs to run outside it, set unsandboxed: true — the user is always asked.',
    inputSchema: {
      type: 'object',
      properties: {
        command: str('Command line to run'),
        background: {type: 'boolean', description: 'Run in the background and return immediately'},
        timeout_ms: {type: 'integer', description: `Foreground timeout in ms (default ${DEFAULT_TIMEOUT_MS})`},
        cwd: str('Working directory relative to the project root (default: root)'),
        unsandboxed: {type: 'boolean', description: "Run outside Rein's sandbox (always asks the user). Only when the sandbox blocked something the command really needs."},
        interactive: {type: 'boolean', description: 'Run in a terminal the user can type into when it asks for input (foreground only). Use only when non-interactive flags are not an option.'},
      },
      required: ['command'],
    },
    mutating: true,
    run: shellTool,
    summarize: (a) => `${a?.background ? '&' : '$'} ${String(a?.command ?? '').replace(/\s+/g, ' ').slice(0, 80)}${a?.interactive ? ' (interactive)' : ''}`,
  },
  {
    name: 'shell_logs',
    label: 'ShellLogs',
    description: 'Read recent output of a background shell started with shell (or list all shells when id is omitted).',
    inputSchema: {type: 'object', properties: {id: {type: 'integer', description: 'Shell id'}, lines: {type: 'integer', description: 'Tail length (default 200)'}}},
    mutating: false,
    run: async (ctx, args) => {
      const shells = ctx.shells;
      if (!shells) throw new ToolError('shell is not available');
      if (args?.id === undefined) {
        const all = shells.list();
        return {ok: true, text: all.length ? all.map((s) => `#${s.id} ${s.background ? 'background' : 'foreground'} · ${shellStatusText(s)} · ${s.command}`).join('\n') : 'No shells.'};
      }
      const s = shells.get(Number(args.id));
      if (!s) throw new ToolError(`no shell #${args.id}`);
      return {ok: true, text: `#${s.id} ${shellStatusText(s)} · ${s.command}\n${shells.tail(s, Math.max(1, Math.min(2000, Number(args.lines) || 200))) || '(no output yet)'}`};
    },
    summarize: (a) => (a?.id === undefined ? 'all' : `#${a.id}`),
  },
  {
    name: 'shell_kill',
    label: 'ShellKill',
    description: 'Stop a running shell (and its child processes) by id.',
    inputSchema: {type: 'object', properties: {id: {type: 'integer'}}, required: ['id']},
    mutating: false,
    run: async (ctx, args) => {
      const s = ctx.shells?.get(Number(args?.id));
      if (!s) throw new ToolError(`no shell #${args?.id}`);
      if (!ctx.shells!.kill(s.id)) return {ok: true, text: `#${s.id} already ${shellStatusText(s)}`};
      return {ok: true, text: `Stopped #${s.id} (${s.command})`};
    },
    summarize: (a) => `#${a?.id ?? '?'}`,
  },
];

TOOLS.push(
  {
    name: 'sessions_search',
    label: 'SessionSearch',
    description:
      'Search saved conversations (messages and their tool calls) with a regex, newest first. This project by default; all_projects: true searches every project. Returns `sessionId · date · #index role: snippet`.',
    inputSchema: {
      type: 'object',
      properties: {pattern: str('Regular expression (case-insensitive by default)'), all_projects: {type: 'boolean'}, case_sensitive: {type: 'boolean'}},
      required: ['pattern'],
    },
    mutating: false,
    run: sessionsSearch,
    summarize: (a) => `${a?.pattern ?? ''}${a?.all_projects ? ' (all projects)' : ''}`,
  },
  {
    name: 'session_read',
    label: 'SessionRead',
    description: 'Read a saved conversation by id (from sessions_search): messages with their tool calls, paged with offset/limit (default 30).',
    inputSchema: {type: 'object', properties: {id: str('Session id'), offset: {type: 'integer'}, limit: {type: 'integer'}}, required: ['id']},
    mutating: false,
    run: sessionRead,
    summarize: (a) => `${a?.id ?? ''}${a?.offset ? ` @${a.offset}` : ''}`,
  },
);

const MAX_SHELL_OUTPUT = 30_000;
/** shell-cap: output longer than this keeps its first and last lines in the result. */
const SHELL_CAP = 8_000;
const SHELL_CAP_HEAD = 2_000;
const SHELL_CAP_TAIL = 5_000;

/**
 * shell-cap: everything a command printed stays in the conversation for every later request, and a
 * long output is mostly noise. Keep the start (the command's first errors) and the end (the summary),
 * and save the whole output to the scratchpad, where the model can read or search any part of it.
 */
function capOutput(ctx: ToolContext, id: number, out: string): string {
  if (out.length <= SHELL_CAP || !ctx.scratch) return out;
  const file = path.join(ctx.scratch, `shell-${id}.log`);
  try {
    writeFileSync(file, out);
  } catch {
    return out;
  }
  const head = out.slice(0, out.lastIndexOf('\n', SHELL_CAP_HEAD) + 1 || SHELL_CAP_HEAD);
  const tailStart = out.indexOf('\n', out.length - SHELL_CAP_TAIL);
  const tail = out.slice(tailStart < 0 ? out.length - SHELL_CAP_TAIL : tailStart + 1);
  const left = out.slice(head.length, out.length - tail.length);
  return `${head}[… ${left.split('\n').length} lines (${Math.round(left.length / 1000)}K chars) left out here. The output is saved in ${file}: search or read it for anything else.]\n${tail}`;
}

/** Output of a command that failed for want of a terminal. */
export const needsTerminal = (out: string) => /not a tty|not a terminal|inappropriate ioctl|must be run (from|in) a terminal|requires a tty|no tty present|input device is not a TTY|interactive mode requires|cannot prompt|unable to prompt|stdin is not interactive/i.test(out);

async function shellTool(ctx: ToolContext, args: {command: string; background?: boolean; timeout_ms?: number; cwd?: string; unsandboxed?: boolean; interactive?: boolean}): Promise<ToolResult> {
  if (!ctx.shells) throw new ToolError('shell is not available');
  if (typeof args?.command !== 'string' || !args.command.trim()) throw new ToolError('command is required');
  if (args.interactive && args.background) throw new ToolError('interactive commands run in the foreground (the user may need to answer them): drop background');
  const cwd = resolveInRoot(ctx, args.cwd ?? '.');
  await ctx.shells.devEnv?.ready(); // devEnvironment: the container or Nix shell, started once
  // The sandbox may write to the project and every working directory (subagent worktrees included).
  const sandbox: SandboxSpec | undefined = ctx.sandbox && ctx.sandbox !== 'off' && !args.unsandboxed ? {mode: ctx.sandbox, roots: [ctx.root, ...(ctx.extraRoots ?? [])]} : undefined;
  const {shell, done} = ctx.shells.start(args.command, {cwd, background: !!args.background, timeoutMs: args.timeout_ms, maxMs: ctx.shellMaxMs, origin: ctx.origin, sandbox, tty: !!args.interactive});
  if (args.background) {
    return {ok: true, text: `Started background shell #${shell.id}${shell.pid ? ` (pid ${shell.pid})` : ''}: ${args.command}\nRead its output with shell_logs {id: ${shell.id}}; stop it with shell_kill {id: ${shell.id}}.`};
  }
  const s = await done;
  let out = ctx.shells.tail(s, 2000);
  if (ctx.shellCap) out = capOutput(ctx, shell.id, ctx.shells.saved(s));
  else if (out.length > MAX_SHELL_OUTPUT) out = '[… output truncated]\n' + out.slice(-MAX_SHELL_OUTPUT);
  const ok = s.status === 'exited' && s.exitCode === 0;
  const status = s.status === 'killed' ? (s.noUser ? `stopped after ${Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000)}s: waiting for input nobody can give` : 'killed (interrupted by the user)') : shellStatusText(s);
  const note = !ok && sandbox && s.sandboxed ? denialNote(out, sandbox) : undefined;
  const ttyNote = !ok && !args.interactive && needsTerminal(out) ? '\n\n<terminal_note>This command wanted a terminal. Look for a non-interactive flag first; if there is none, run it again with interactive: true (the user can answer it).</terminal_note>' : '';
  return {ok, text: `[${status}]\n${out || '(no output)'}${note ? `\n\n${note}` : ''}${ttyNote}`};
}

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);
