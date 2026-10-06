import {constants, createReadStream, createWriteStream, existsSync, lstatSync, realpathSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import readline from 'node:readline';
import {createdDiff, fileDiff, regionDiff, type DiffLine} from './diff.js';
import {mkdir, open, readdir, rename, rm, rmdir, stat, type FileHandle} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {run} from '../util/proc.js';
import {isImage, isPdf, readImage, readPdf} from './media.js';

/** `diff`: shown to the user under the tool line (never sent to the model). */
/** `images` go to the model as real images (read on a PNG/JPEG/GIF/WebP). */
export type ToolImage = {mime: string; base64: string};
export type ToolResult = {ok: boolean; text: string; diff?: DiffLine[]; images?: ToolImage[]};
export type ToolContext = {
  root: string;
  /** Other working directories (scratchpad, global skills, /add-dir and config additions). */
  extraRoots?: string[];
  /** This session's scratchpad (also one of extraRoots). */
  scratch?: string;
  /** Files read in this conversation and their state then (stale-file protection); undefined = off. */
  reads?: Map<string, FileStamp>;
  /** Paths outside the working directories the user approved for this one call. */
  outsideAllowed?: string[];
  shells?: import('./shells.js').ShellManager;
  shellMaxMs?: number;
  /** Sandbox for the agent's shell commands (see sandbox.ts). */
  sandbox?: import('./sandbox.js').SandboxMode;
  /** Current conversation id (marks it in session search). */
  sessionId?: string;
  /** Set when a subagent is calling (its shells are tagged with it). */
  origin?: Origin;
};

/** Which subagent made a tool call (undefined = the main agent). */
export type Origin = {agentId: number; name: string};

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_SEARCH_LINES = 200;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__']);

export class ToolError extends Error {}

/**
 * Resolve a model-supplied path inside the project root. Symlinks are resolved on the nearest
 * existing ancestor, so `link → /etc` can't be used to escape.
 */
const within = (real: string, dir: string) => real === dir || real.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** The project root plus every other working directory, symlinks resolved. */
export function workingDirs(ctx: ToolContext): string[] {
  return [realpathSync(ctx.root), ...(ctx.extraRoots ?? []).filter(existsSync).map((r) => realpathSync(r))];
}

/**
 * Where a path really points (relative to the project root; absolute and `~/` work too), with
 * symlinks resolved, and whether that's inside a working directory.
 */
export function resolvePath(ctx: ToolContext, p: string): {real: string; inside: boolean} {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('path is required');
  const expanded = p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
  const abs = path.resolve(realpathSync(ctx.root), expanded);
  let existing = abs;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(realpathSync(existing), path.relative(existing, abs));
  return {real, inside: workingDirs(ctx).some((d) => within(real, d))};
}

/**
 * Resolve a tool's path. Outside the working directories it's refused unless the user approved
 * that path for this call (the tool host asks before running the tool, like Claude Code does).
 */
export function resolveInRoot(ctx: ToolContext, p: string): string {
  const {real, inside} = resolvePath(ctx, p);
  if (!inside && !(ctx.outsideAllowed ?? []).some((a) => within(real, a))) {
    throw new ToolError(`${p} is outside the project and its working directories, and wasn't approved`);
  }
  return real;
}

/** What a file looked like when the agent last read or wrote it. */
export type FileStamp = {mtimeMs: number; size: number};
const stampOf = (st: {mtimeMs: number; size: number}): FileStamp => ({mtimeMs: st.mtimeMs, size: st.size});

/**
 * Stale-file protection (like Claude Code's read-before-edit): changing an existing file requires
 * that it was read in this conversation and hasn't changed since — otherwise the agent would edit
 * from contents it never saw, or overwrite someone else's newer changes. The scratchpad is exempt.
 */
function checkFresh(ctx: ToolContext, file: string, display: string, st: {mtimeMs: number; size: number}): void {
  if (!ctx.reads || (ctx.scratch && (file === ctx.scratch || file.startsWith(ctx.scratch + path.sep)))) return;
  const seen = ctx.reads.get(file);
  if (!seen) throw new ToolError(`read ${display} before changing it (it exists and you haven't read it in this conversation)`);
  if (seen.mtimeMs !== st.mtimeMs || seen.size !== st.size) throw new ToolError(`${display} changed since you last read it (edited outside this conversation, or by a command) — read it again, then redo the change`);
}

/** Paths shown to models and users use `/` on every platform (Windows paths included). */
export const toPosix = (p: string) => (path.sep === '\\' ? p.replace(/\\/g, '/') : p);

export const rel = (ctx: ToolContext, abs: string) => toPosix(path.relative(realpathSync(ctx.root), abs)) || '.';

/**
 * Streams the file and stops as soon as the requested lines are collected, so reading the top of a
 * huge file (or a slice of it) never loads the whole thing. Only the first 8 KB are inspected for
 * binary content.
 */
export async function readTool(ctx: ToolContext, args: {path: string; offset?: number; limit?: number; pages?: string}): Promise<ToolResult> {
  const file = resolveInRoot(ctx, args.path);
  const st = await stat(file).catch(() => undefined);
  if (!st) throw new ToolError(`${args.path} does not exist`);
  if (st.isDirectory()) {
    const entries = await readdir(file, {withFileTypes: true});
    const list = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    return {ok: true, text: `${rel(ctx, file)}/ is a directory:\n${list.join('\n') || '(empty)'}`};
  }
  ctx.reads?.set(file, stampOf(st));
  if (isImage(file)) return readImage(file, rel(ctx, file));
  if (isPdf(file)) return readPdf(file, rel(ctx, file), args.pages);
  if (await looksBinary(file)) return {ok: true, text: `${rel(ctx, file)} is a binary file (${st.size} bytes)`};
  const start = Math.max(1, Math.floor(args.offset ?? 1));
  const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(args.limit ?? MAX_READ_LINES)));
  const out: string[] = [];
  let n = 0;
  let more = false;
  const stream = createReadStream(file, {encoding: 'utf8', highWaterMark: 256 * 1024});
  const rl = readline.createInterface({input: stream, crlfDelay: Infinity});
  try {
    for await (const line of rl) {
      n++;
      if (n < start) continue;
      if (out.length >= limit) {
        more = true;
        break;
      }
      out.push(`${String(n).padStart(6)}\t${line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '… [line truncated]' : line}`);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (!out.length) return {ok: true, text: n ? `(the file has only ${n} lines)` : '(empty file)'};
  const end = start + out.length - 1;
  return {ok: true, text: out.join('\n') + (more ? `\n… more lines follow (use offset=${end + 1}; file is ${size(st.size)})` : '')};
}

const MAX_READ_MANY = 20;

/**
 * Several files in one call (`paths`), each headed by its path: the files a change needs, read in one
 * round trip instead of one per file. Whole text files only; a failure on one is reported in its place.
 */
export async function readManyTool(ctx: ToolContext, args: {paths: string[]}): Promise<ToolResult> {
  if (!Array.isArray(args.paths) || !args.paths.length || args.paths.some((p) => typeof p !== 'string')) throw new ToolError('paths must be a non-empty list of file paths');
  if (args.paths.length > MAX_READ_MANY) throw new ToolError(`at most ${MAX_READ_MANY} paths per call`);
  const parts: string[] = [];
  let ok = false;
  for (const p of [...new Set(args.paths)]) {
    let text: string;
    try {
      const file = resolveInRoot(ctx, p);
      if (isImage(file) || isPdf(file)) text = '(an image or PDF: read it on its own)';
      else {
        const r = await readTool(ctx, {path: p});
        text = r.text;
        ok ||= r.ok;
      }
    } catch (err) {
      text = `error: ${(err as Error).message}`;
    }
    parts.push(`==> ${p} <==\n${text}`);
  }
  return {ok, text: parts.join('\n\n')};
}

async function looksBinary(file: string): Promise<boolean> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(8000);
    const {bytesRead} = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close().catch(() => {}); // may already be closed (streaming edit)
  }
}

/**
 * Open a file that resolveInRoot already confined, without following a symlink at the last path
 * component: if the file was swapped for a symlink after the check (e.g. by a background shell),
 * the open fails instead of writing outside the project. All later reads/writes use the handle.
 */
export async function openConfined(file: string, display: string, flags: number): Promise<FileHandle> {
  // Windows has no O_NOFOLLOW: refuse a symlink explicitly instead (a tiny window remains there).
  if (!constants.O_NOFOLLOW) {
    try {
      if (lstatSync(file).isSymbolicLink()) throw new ToolError(`${display} became a symlink after it was checked; refusing to follow it`);
    } catch (err) {
      if (err instanceof ToolError) throw err;
    }
  }
  try {
    return await open(file, flags | constants.O_NOFOLLOW, 0o666);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') throw new ToolError(`${display} became a symlink after it was checked; refusing to follow it`);
    if (code === 'EISDIR') throw new ToolError(`${display} is a directory`);
    throw err;
  }
}

/** Replace the whole content behind a handle. */
async function overwrite(fh: FileHandle, text: string): Promise<void> {
  const buf = Buffer.from(text, 'utf8');
  await fh.truncate(0);
  for (let off = 0; off < buf.length; ) off += (await fh.write(buf, off, buf.length - off, off)).bytesWritten;
}

export async function writeTool(ctx: ToolContext, args: {path: string; content: string}): Promise<ToolResult> {
  if (typeof args.content !== 'string') throw new ToolError('content is required');
  const file = resolveInRoot(ctx, args.path);
  let fh: FileHandle;
  let existed = true;
  try {
    fh = await openConfined(file, args.path, constants.O_RDWR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    existed = false;
    await mkdir(path.dirname(file), {recursive: true});
    // O_EXCL: if something appeared at this path meanwhile, fail rather than reuse it.
    fh = await openConfined(file, args.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
  }
  let before: string | undefined;
  try {
    const st = await fh.stat();
    if (st.isDirectory()) throw new ToolError(`${args.path} is a directory`);
    if (existed) checkFresh(ctx, file, args.path, st);
    if (existed && st.size <= 1024 * 1024) before = await fh.readFile('utf8');
    await overwrite(fh, args.content);
    ctx.reads?.set(file, stampOf(await fh.stat())); // the agent knows what it just wrote
  } finally {
    await fh.close().catch(() => {}); // may already be closed (streaming edit)
  }
  const diff = !existed ? createdDiff(args.content) : before !== undefined ? fileDiff(before, args.content) : undefined;
  const n = args.content ? args.content.split('\n').length - (args.content.endsWith('\n') ? 1 : 0) : 0;
  return {ok: true, text: `${existed ? 'Overwrote' : 'Created'} ${rel(ctx, file)} (${n} line${n === 1 ? '' : 's'})`, diff};
}

/** Files above this are edited by streaming (constant memory) instead of in memory. */
const STREAM_EDIT_BYTES = 8 * 1024 * 1024;

export type EditSpec = {path?: string; old_string: string; new_string: string; replace_all?: boolean};

export async function editTool(ctx: ToolContext, args: {path: string; old_string: string; new_string: string; replace_all?: boolean; edits?: EditSpec[]}): Promise<ToolResult> {
  if (args.edits !== undefined) return multiEdit(ctx, args);
  const file = resolveInRoot(ctx, args.path);
  if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') throw new ToolError('old_string and new_string are required');
  if (!args.old_string) throw new ToolError('old_string is empty; use write to create a file');
  if (args.old_string === args.new_string) throw new ToolError('old_string and new_string are identical');
  let fh: FileHandle;
  try {
    fh = await openConfined(file, args.path, constants.O_RDWR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ToolError(`${args.path} does not exist`);
    throw err;
  }
  let text: string;
  let next: string;
  let count: number;
  try {
    const st = await fh.stat();
    if (st.isDirectory()) throw new ToolError(`${args.path} does not exist`);
    checkFresh(ctx, file, args.path, st);
    if (st.size > STREAM_EDIT_BYTES) return await streamingEdit(ctx, file, fh, args);
    text = await fh.readFile('utf8');
    count = text.split(args.old_string).length - 1;
    checkCount(ctx, file, count, args.replace_all);
    next = args.replace_all ? text.split(args.old_string).join(args.new_string) : text.replace(args.old_string, () => args.new_string);
    await overwrite(fh, next);
    ctx.reads?.set(file, stampOf(await fh.stat()));
  } finally {
    await fh.close().catch(() => {}); // may already be closed (streaming edit)
  }
  const line = text.slice(0, text.indexOf(args.old_string)).split('\n').length;
  const diff = fileDiff(text, next) ?? regionDiff(line, args.old_string, args.new_string);
  return {ok: true, text: `Edited ${rel(ctx, file)}: ${args.replace_all ? `${count} replacements` : `1 replacement at line ${line}`}`, diff};
}

/**
 * Several replacements in one call, in one file or several: each edit applies to the file as the
 * edits before it left it. Every edit is checked before anything is written, so the call changes all
 * of its files or none (a failed edit names its index). One call instead of a round trip per edit.
 */
async function multiEdit(ctx: ToolContext, args: {path?: string; old_string?: string; edits?: EditSpec[]}): Promise<ToolResult> {
  if (!Array.isArray(args.edits) || !args.edits.length) throw new ToolError('edits must be a non-empty list of {path, old_string, new_string}');
  if (args.old_string !== undefined) throw new ToolError('pass either old_string/new_string or edits, not both');
  // One handle per file, opened once and used for both the read and the write (no check-then-use race).
  const files = new Map<string, {display: string; fh: FileHandle; before: string; text: string; count: number}>();
  try {
    for (const [i, e] of args.edits.entries()) {
      const where = `edits[${i}]`;
      const display = e?.path ?? args.path;
      if (typeof display !== 'string') throw new ToolError(`${where}: path is required (on the edit, or for all of them at the top level)`);
      if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') throw new ToolError(`${where}: old_string and new_string are required`);
      if (!e.old_string) throw new ToolError(`${where}: old_string is empty; use write to create a file`);
      if (e.old_string === e.new_string) throw new ToolError(`${where}: old_string and new_string are identical`);
      const file = resolveInRoot(ctx, display);
      let f = files.get(file);
      if (!f) {
        let fh: FileHandle;
        try {
          fh = await openConfined(file, display, constants.O_RDWR);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') throw new ToolError(`${where}: ${display} does not exist`);
          throw err;
        }
        files.set(file, (f = {display, fh, before: '', text: '', count: 0}));
        const st = await fh.stat();
        if (st.isDirectory()) throw new ToolError(`${where}: ${display} does not exist`);
        if (st.size > STREAM_EDIT_BYTES) throw new ToolError(`${where}: ${display} is over ${size(STREAM_EDIT_BYTES)}; edit it with a single edit call`);
        checkFresh(ctx, file, display, st);
        f.before = f.text = await fh.readFile('utf8');
      }
      const n = f.text.split(e.old_string).length - 1;
      if (n === 0) throw new ToolError(`${where}: old_string not found in ${rel(ctx, file)} (it must match exactly, including whitespace, and edits apply in order)`);
      if (n > 1 && !e.replace_all) throw new ToolError(`${where}: old_string matches ${n} places in ${rel(ctx, file)}; include more surrounding context to make it unique, or set replace_all`);
      f.text = e.replace_all ? f.text.split(e.old_string).join(e.new_string) : f.text.replace(e.old_string, () => e.new_string);
      f.count += e.replace_all ? n : 1;
    }
    // All checked: write them.
    const diff: DiffLine[] = [];
    const done: string[] = [];
    for (const [file, f] of files) {
      await overwrite(f.fh, f.text);
      ctx.reads?.set(file, stampOf(await f.fh.stat()));
      if (files.size > 1) diff.push({kind: 'note', text: rel(ctx, file)});
      diff.push(...(fileDiff(f.before, f.text) ?? []));
      done.push(`${rel(ctx, file)} (${f.count} replacement${f.count === 1 ? '' : 's'})`);
    }
    return {ok: true, text: `Edited ${files.size === 1 ? done[0] : `${files.size} files: ${done.join(', ')}`}`, diff};
  } finally {
    for (const f of files.values()) await f.fh.close().catch(() => {});
  }
}

function checkCount(ctx: ToolContext, file: string, count: number, replaceAll?: boolean): void {
  if (count === 0) throw new ToolError(`old_string not found in ${rel(ctx, file)} (it must match exactly, including whitespace)`);
  if (count > 1 && !replaceAll) throw new ToolError(`old_string matches ${count} places in ${rel(ctx, file)}; include more surrounding context to make it unique, or set replace_all`);
}

/**
 * Large files: one streaming pass counts matches (matches spanning chunk boundaries included),
 * a second streams the replaced content into a temp file that is renamed over the original.
 */
async function streamingEdit(ctx: ToolContext, file: string, fh: FileHandle, args: {old_string: string; new_string: string; replace_all?: boolean}): Promise<ToolResult> {
  const old = args.old_string;
  const scan = async (onOut?: (s: string) => void): Promise<number> => {
    let carry = '';
    let count = 0;
    // Both passes read through the already-open handle (never re-opened by path).
    for await (const chunk of fh.createReadStream({encoding: 'utf8', highWaterMark: 1024 * 1024, start: 0, autoClose: false})) {
      const buf = carry + (chunk as string);
      let i = 0;
      let j: number;
      let out = '';
      while ((j = buf.indexOf(old, i)) !== -1) {
        count++;
        if (onOut) out += buf.slice(i, j) + (args.replace_all || count === 1 ? args.new_string : old);
        i = j + old.length;
      }
      // Keep a tail that could be the start of a match continuing into the next chunk.
      const keep = Math.max(i, buf.length - (old.length - 1));
      if (onOut) onOut(out + buf.slice(i, keep));
      carry = buf.slice(keep);
    }
    if (onOut && carry) onOut(carry);
    return count;
  };
  const count = await scan();
  checkCount(ctx, file, count, args.replace_all);
  // Unpredictable name, created exclusively (`wx`) with the original file's permissions, so a
  // pre-planted file or symlink at the temp path can't be written through.
  const tmp = `${file}.rein-${randomBytes(8).toString('hex')}.tmp`;
  const out = createWriteStream(tmp, {flags: 'wx', mode: (await fh.stat()).mode & 0o777});
  try {
    await scan((s) => void out.write(s));
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    // Windows can't replace a file that's still open: release the original first.
    await fh.close().catch(() => {});
    await rename(tmp, file);
    ctx.reads?.set(file, stampOf(await stat(file)));
  } catch (err) {
    await rm(tmp, {force: true});
    throw err;
  }
  return {
    ok: true,
    text: `Edited ${rel(ctx, file)}: ${args.replace_all ? `${count} replacements` : '1 replacement'} (streamed, ${size((await stat(file)).size)})`,
    diff: regionDiff(0, args.old_string, args.new_string).map((l) => ({...l, n: undefined})),
  };
}

export async function deleteTool(ctx: ToolContext, args: {path: string; recursive?: boolean}): Promise<ToolResult> {
  const file = resolveInRoot(ctx, args.path);
  if (file === realpathSync(ctx.root)) throw new ToolError('refusing to delete the project root');
  const st = await stat(file).catch(() => undefined);
  if (!st) throw new ToolError(`${args.path} does not exist`);
  if (st.isDirectory()) {
    const entries = await readdir(file);
    if (entries.length && !args.recursive) throw new ToolError(`${args.path} is a non-empty directory (${entries.length} entries); pass recursive: true to delete it`);
    if (entries.length) await rm(file, {recursive: true});
    else await rmdir(file);
    return {ok: true, text: `Deleted directory ${rel(ctx, file)}`};
  }
  await rm(file);
  return {ok: true, text: `Deleted ${rel(ctx, file)}`};
}

const MAX_LIST_ENTRIES = 500;

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/**
 * List a directory as an indented tree: folders first (with a trailing /), files with sizes.
 * `depth` levels deep (default 1); hidden entries and heavy dirs (.git, node_modules, …) are skipped
 * unless `all`.
 */
export async function listTool(ctx: ToolContext, args: {path?: string; depth?: number; all?: boolean}): Promise<ToolResult> {
  const dir = resolveInRoot(ctx, args.path ?? '.');
  const st = await stat(dir).catch(() => undefined);
  if (!st) throw new ToolError(`${args.path ?? '.'} does not exist`);
  if (!st.isDirectory()) return {ok: true, text: `${rel(ctx, dir)} is a file (${size(st.size)})`};
  const maxDepth = Math.max(1, Math.min(5, Math.floor(args.depth ?? 1)));
  const out: string[] = [];
  let total = 0;
  const walk = async (d: string, depth: number, indent: string): Promise<void> => {
    const entries = (await readdir(d, {withFileTypes: true}).catch(() => []))
      .filter((e) => args.all || (!e.name.startsWith('.') && !(e.isDirectory() && SKIP_DIRS.has(e.name))))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      total++;
      if (out.length >= MAX_LIST_ENTRIES) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        out.push(`${indent}${e.name}/`);
        if (depth < maxDepth) await walk(full, depth + 1, indent + '  ');
      } else {
        const s = await stat(full).catch(() => undefined);
        out.push(`${indent}${e.name}${s ? `  (${size(s.size)})` : ''}`);
      }
    }
  };
  await walk(dir, 1, '');
  const header = `${rel(ctx, dir)}/`;
  if (!out.length) return {ok: true, text: `${header} (empty${args.all ? '' : '; hidden entries skipped — pass all: true'})`};
  return {ok: true, text: `${header}\n${out.join('\n')}${total > out.length ? `\n… ${total - out.length} more entries (narrow the path or depth)` : ''}`};
}

type SearchArgs = {pattern: string; path?: string; glob?: string; files_only?: boolean; case_insensitive?: boolean};

/** ripgrep: the bundled binary (@vscode/ripgrep), else one on PATH, else the JS fallback. */
let rgBin: string | null | undefined;
export async function ripgrep(): Promise<string | null> {
  if (rgBin !== undefined) return rgBin;
  for (const candidate of [await import('@vscode/ripgrep').then((m) => m.rgPath, () => undefined), 'rg']) {
    if (!candidate) continue;
    const ok = await run(candidate, ['--version'], {timeoutMs: 5000}).then((r) => r.code === 0, () => false);
    if (ok) return (rgBin = candidate);
  }
  return (rgBin = null);
}

/** Regex search over file contents (`path:line:text`), or file paths when `files_only`. */
export async function searchTool(ctx: ToolContext, args: SearchArgs): Promise<ToolResult> {
  if (typeof args.pattern !== 'string' || !args.pattern) throw new ToolError('pattern is required');
  let re: RegExp;
  try {
    re = new RegExp(args.pattern, args.case_insensitive ? 'i' : '');
  } catch (err) {
    throw new ToolError(`invalid regex: ${(err as Error).message}`);
  }
  const base = resolveInRoot(ctx, args.path ?? '.');
  const root = realpathSync(ctx.root);
  let lines: string[];
  const rg = await ripgrep();
  if (rg) {
    // ripgrep: parallel, respects .gitignore, skips binaries, stops per file at --max-count.
    const flags = [...(args.glob ? ['-g', args.glob] : []), ...(args.case_insensitive ? ['-i'] : [])];
    const res = args.files_only
      ? await run(rg, ['--files', '--color', 'never', ...flags, base], {timeoutMs: 30_000})
      : await run(rg, ['-n', '--no-heading', '--color', 'never', '-M', '400', '--max-count', String(MAX_SEARCH_LINES), ...flags, '-e', args.pattern, '--', base], {timeoutMs: 30_000});
    if (res.code !== 0 && res.code !== 1) throw new ToolError(`search failed: ${res.stderr.trim().slice(0, 300)}`);
    lines = res.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => (l.startsWith(root + path.sep) ? l.slice(root.length + 1) : l))
      // Only the path part becomes /-separated: matched code may contain backslashes.
      .map((l) => {
        if (args.files_only) return toPosix(l);
        const m = /^(.*?):(\d+):/.exec(l);
        return m ? toPosix(m[1]!) + l.slice(m[1]!.length) : l;
      });
    if (args.files_only) lines = lines.filter((f) => re.test(f));
  } else {
    lines = await jsSearch(root, base, re, args);
  }
  if (!lines.length) return {ok: true, text: 'No matches.'};
  const shown = lines.slice(0, MAX_SEARCH_LINES);
  return {ok: true, text: shown.join('\n') + (lines.length > shown.length ? `\n… ${lines.length - shown.length} more (showing ${MAX_SEARCH_LINES}; narrow the pattern or path)` : '')};
}

async function jsSearch(root: string, base: string, re: RegExp, args: SearchArgs): Promise<string[]> {
  const out: string[] = [];
  const globRe = args.glob ? globToRegExp(args.glob) : undefined;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, {withFileTypes: true}).catch(() => [])) {
      if (out.length > MAX_SEARCH_LINES * 5) return;
      const full = path.join(dir, e.name);
      const relPath = toPosix(path.relative(root, full));
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
        continue;
      }
      if (globRe && !globRe.test(e.name) && !globRe.test(relPath)) continue;
      if (args.files_only) {
        if (re.test(relPath)) out.push(relPath);
        continue;
      }
      if (await looksBinary(full).catch(() => true)) continue;
      await grepFile(full, relPath, re, out);
    }
  };
  const st = await stat(base);
  if (st.isDirectory()) await walk(base);
  else await grepFile(base, toPosix(path.relative(root, base)), re, out);
  return out;
}

/** Stream one file line by line (any size); stops once enough matches are collected. */
async function grepFile(file: string, relPath: string, re: RegExp, out: string[]): Promise<void> {
  const stream = createReadStream(file, {encoding: 'utf8', highWaterMark: 256 * 1024});
  const rl = readline.createInterface({input: stream, crlfDelay: Infinity});
  let n = 0;
  try {
    for await (const line of rl) {
      n++;
      if (re.test(line)) out.push(`${relPath}:${n}:${line.slice(0, 400)}`);
      if (out.length > MAX_SEARCH_LINES * 5) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Minimal glob (`*`, `**`, `?`, `{a,b}`) → RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(${glob.slice(i + 1, end).split(',').map(escape).join('|')})`;
      i = end;
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`);
}
const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
