/**
 * The extension API: what a marketplace item's code gets. An item with `"main": "index.js"` and
 * `"api": 1` in its rein.json exports `activate(rein)`; Rein calls it at startup (and after the
 * item is installed) with an object of this shape. Everything an item does goes through it: an item
 * can't import Rein's own modules.
 *
 * Item authors: `import type {Rein} from 'rein-harness/api'` for the types.
 */
/** 1: commands, tools, UI, services. 2: checks (endOfTurn, afterEdit) and the requestStart event. */
export const API_VERSION = 3;

export type LogKind = 'info' | 'error';

/** What a command's handler can do, for the one run it's called for. */
export type CommandContext = {
  /** The project folder Rein is working in. */
  cwd: string;
  /** Print a line (or lines) into the conversation, as Rein's own commands do. */
  log(text: string, kind?: LogKind): void;
  /** Send a message to the agent, as if the user typed it (queued if the agent is busy). */
  send(text: string): void;
  /** Show text in a window over the conversation (fullscreen; printed in the classic renderer). */
  window(title: string, lines: string[]): void;
};

export type Command = {
  /** Without the slash: `services` is `/services`. Rein's own commands win a clash. */
  name: string;
  /** One line for the `/` list. */
  description: string;
  /** The full line with arguments, for /help (defaults to the description). */
  usage?: string;
  /** Only when typed (not in a bare `/` list). */
  listed?: boolean;
  run(args: string, ctx: CommandContext): void | Promise<void>;
};

export type ToolResult = {ok: boolean; text: string};
export type Tool = {
  /** Letters, digits and underscores; the model sees it as is. */
  name: string;
  /** Shown in the conversation: `Services(…)`. */
  label: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** Changes files or runs things: goes through the user's approvals first. */
  mutating?: boolean;
  /** A short argument summary for the conversation and the approval prompt. */
  summarize?(args: any): string;
  run(args: any, ctx: {cwd: string}): Promise<ToolResult>;
};

/** A section at the bottom of the fullscreen sidebar, drawn by the item: lines of text (ANSI colours allowed). */
export type SidebarSection = {id: string; title: string; render(width: number): string[]};
/** A segment at the end of the status line: a short string (ANSI colours allowed), or nothing to hide it. */
export type StatusSegment = {id: string; render(): string | undefined};
/** Colours for Rein's UI: `accent` for the input box, window frames, tabs and selections (a name or #hex). */
export type Theme = {accent?: string};

export type ExecResult = {code: number; stdout: string; stderr: string};

/** A file the current request changed: its path in the project, and its text before and now (undefined: it didn't exist then / was deleted). */
export type ChangedFile = {path: string; before?: string; after?: string};
/**
 * A check when the agent ends a turn, over what the request changed: a note returned goes back to
 * the agent (it carries on to address it), as Rein's own end-of-turn checks do. Each check runs at
 * most once per request.
 */
export type EndOfTurnCheck = {id: string; run(changed: ChangedFile[]): string | undefined | Promise<string | undefined>};
/** After each edit the agent makes (not a subagent's): a note returned is added to the edit's result. */
export type AfterEditCheck = {id: string; run(edit: {path: string; args: unknown}): string | undefined};

export type Rein = {
  /** The API version this Rein speaks (an item needing a newer one isn't loaded). */
  version: number;
  /** This item's id, and a folder of its own for files it keeps. */
  item: {id: string; dir: string; dataDir: string};
  registerCommand(c: Command): void;
  registerTool(t: Tool): void;
  ui: {
    sidebarSection(s: SidebarSection): void;
    statusSegment(s: StatusSegment): void;
    theme(t: Theme): void;
    /** Ask Rein to draw again (after what a section or segment shows has changed). */
    redraw(): void;
  };
  /** Run a program (no shell), in `cwd` (default: the project). */
  exec(command: string, args: string[], opts?: {cwd?: string; timeoutMs?: number}): Promise<ExecResult>;
  /**
   * A shell command line run as the agent's own commands are: through the shell tool, so the
   * approval mode, permission rules and sandbox apply (in ask mode the user approves it first).
   * `ok` is false when it failed or wasn't allowed. API 3.
   */
  shell(command: string, opts?: {timeoutMs?: number}): Promise<{ok: boolean; text: string}>;
  /** git, in `cwd` (default: the project). */
  git(args: string[], cwd?: string): Promise<ExecResult>;
  /** The ripgrep that ships with Rein (undefined if it's missing). */
  ripgrep(): Promise<string | undefined>;
  /** The workspace Rein is in (rein.workspace.yaml), or undefined. */
  workspace(): {root: string; repos: {name: string; path: string; present: boolean; role?: string}[]} | undefined;
  /** Rein's settings (read-only), and this item's own settings (kept in its data folder). */
  config(): Record<string, unknown>;
  settings: {get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void};
  /** Checks on the agent's work: at the end of a turn, and after each edit. */
  checks: {endOfTurn(c: EndOfTurnCheck): void; afterEdit(c: AfterEditCheck): void};
  /** Things that happen: a turn of the agent ended, or a new request (your message) started. Returns a function that stops listening. */
  on(event: 'turnEnd' | 'requestStart', fn: () => void): () => void;
};
