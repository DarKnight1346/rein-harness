import path from 'node:path';
import {deleteTool, editTool, listTool, readTool, resolveInRoot, searchTool, ToolError, writeTool, type ToolContext, type ToolResult} from './fs.js';
import {DEFAULT_TIMEOUT_MS, shellStatusText} from './shells.js';
import {shellFor} from '../util/platform.js';
import {sessionRead, sessionsSearch} from './sessions.js';

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
    paths: (args) => [args?.path].filter((x): x is string => typeof x === 'string'),
    label: 'Read',
    description:
      'Read a file in the project. Returns lines prefixed with their 1-based line number and a tab (like `cat -n`); the prefix is not part of the file. Use offset/limit for large files. Reading a directory lists its entries. Images (PNG/JPEG/GIF/WebP) are shown to you as images; PDFs return their text page by page (use pages, e.g. "3-8", for long ones).',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('File path, relative to the project root'),
        offset: {type: 'integer', description: 'First line to read (1-based)'},
        limit: {type: 'integer', description: 'Max lines (default 2000)'},
        pages: str('PDF pages to read, e.g. "1-5" (max 20 per read)'),
      },
      required: ['path'],
    },
    mutating: false,
    run: readTool,
    summarize: (a) => `${a?.path ?? ''}${a?.offset ? `:${a.offset}` : ''}`,
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
    paths: (args) => [args?.path].filter((x): x is string => typeof x === 'string'),
    label: 'Edit',
    description:
      'Replace an exact string in a file. `old_string` must match the file exactly (whitespace included, without read line-number prefixes) and be unique unless `replace_all` is true; include surrounding lines to make it unique. Read the file first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('File path, relative to the project root'),
        old_string: str('Exact text to replace'),
        new_string: str('Replacement text'),
        replace_all: {type: 'boolean', description: 'Replace every occurrence (default false)'},
      },
      required: ['path', 'old_string', 'new_string'],
    },
    mutating: true,
    run: editTool,
    summarize: (a) => String(a?.path ?? ''),
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
      'No stdin/TTY: interactive commands will fail — pass flags like --yes instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: str('Command line to run'),
        background: {type: 'boolean', description: 'Run in the background and return immediately'},
        timeout_ms: {type: 'integer', description: `Foreground timeout in ms (default ${DEFAULT_TIMEOUT_MS})`},
        cwd: str('Working directory relative to the project root (default: root)'),
      },
      required: ['command'],
    },
    mutating: true,
    run: shellTool,
    summarize: (a) => `${a?.background ? '&' : '$'} ${String(a?.command ?? '').replace(/\s+/g, ' ').slice(0, 80)}`,
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

async function shellTool(ctx: ToolContext, args: {command: string; background?: boolean; timeout_ms?: number; cwd?: string}): Promise<ToolResult> {
  if (!ctx.shells) throw new ToolError('shell is not available');
  if (typeof args?.command !== 'string' || !args.command.trim()) throw new ToolError('command is required');
  const cwd = resolveInRoot(ctx, args.cwd ?? '.');
  const {shell, done} = ctx.shells.start(args.command, {cwd, background: !!args.background, timeoutMs: args.timeout_ms, maxMs: ctx.shellMaxMs, origin: ctx.origin});
  if (args.background) {
    return {ok: true, text: `Started background shell #${shell.id}${shell.pid ? ` (pid ${shell.pid})` : ''}: ${args.command}\nRead its output with shell_logs {id: ${shell.id}}; stop it with shell_kill {id: ${shell.id}}.`};
  }
  const s = await done;
  let out = ctx.shells.tail(s, 2000);
  if (out.length > MAX_SHELL_OUTPUT) out = '[… output truncated]\n' + out.slice(-MAX_SHELL_OUTPUT);
  const ok = s.status === 'exited' && s.exitCode === 0;
  const status = s.status === 'killed' ? 'killed (interrupted by the user)' : shellStatusText(s);
  return {ok, text: `[${status}]\n${out || '(no output)'}`};
}

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);
