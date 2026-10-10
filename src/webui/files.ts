import {createReadStream, createWriteStream, existsSync} from 'node:fs';
import {copyFile, cp, mkdir, open, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import type {Readable} from 'node:stream';
import {ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';

/**
 * The web UI's file manager: any folder on this machine (the servers it runs on are often
 * headless). A signed-in user can do what the account running Rein can do, as at its keyboard.
 */
export type Entry = {name: string; path: string; dir: boolean; size: number; modified: number; hidden: boolean; link?: boolean};

export class FileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** An absolute path from what the page sent ("~" is your home folder). */
export function resolvePath(p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) throw new FileError('no path');
  const s = p.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!path.isAbsolute(s)) throw new FileError(`not an absolute path: ${p}`);
  return path.resolve(s);
}

const TEXT_MAX = 2 * 1024 * 1024;

export async function list(dir: string, hidden = false): Promise<{path: string; parent?: string; entries: Entry[]}> {
  const st = await stat(dir).catch(() => undefined);
  if (!st) throw new FileError(`${dir} doesn't exist`, 404);
  if (!st.isDirectory()) throw new FileError(`${dir} isn't a folder`);
  const names = await readdir(dir, {withFileTypes: true}).catch((err) => {
    throw new FileError(`can't open ${dir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, 403);
  });
  const entries: Entry[] = [];
  for (const d of names) {
    const isHidden = d.name.startsWith('.');
    if (isHidden && !hidden) continue;
    const full = path.join(dir, d.name);
    const s = await stat(full).catch(() => undefined); // a broken link shows, as a file of size 0
    entries.push({name: d.name, path: full, dir: !!s?.isDirectory(), size: s?.size ?? 0, modified: s?.mtimeMs ?? 0, hidden: isHidden, ...(d.isSymbolicLink() ? {link: true} : {})});
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));
  const parent = path.dirname(dir);
  return {path: dir, ...(parent !== dir ? {parent} : {}), entries};
}

/** Places to start from: home, and on Windows each drive. */
export async function roots(): Promise<{name: string; path: string}[]> {
  const out = [{name: 'Home', path: os.homedir()}];
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${l}:\\`)) out.push({name: `${l}:`, path: `${l}:\\`});
  } else out.push({name: '/', path: '/'});
  return out;
}

/** A text file's contents (up to 2 MB), or what it is when it isn't text. */
export async function readText(file: string): Promise<{text?: string; size: number; binary?: boolean; tooBig?: boolean}> {
  // One open file: its size and its bytes can't come from two different files.
  const fh = await open(file, 'r').catch(() => undefined);
  if (!fh) throw new FileError(`${file} doesn't exist`, 404);
  try {
    const s = await fh.stat();
    if (s.isDirectory()) throw new FileError(`${file} is a folder`);
    if (s.size > TEXT_MAX) return {size: s.size, tooBig: true};
    return textOf(await fh.readFile(), s.size);
  } finally {
    await fh.close();
  }
}

function textOf(buf: Buffer, size: number): {text?: string; size: number; binary?: boolean} {
  const s = {size};
  // NUL bytes in the first 8 KB: not text.
  if (buf.subarray(0, 8192).includes(0)) return {size: s.size, binary: true};
  return {text: buf.toString('utf8'), size: s.size};
}

export async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, text);
}

/** An upload, streamed to disk (never over an existing file unless `overwrite`). */
export async function upload(dir: string, name: string, body: Readable, overwrite = false): Promise<string> {
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..') throw new FileError(`bad file name: ${name}`);
  const dest = path.join(dir, name);
  if (!overwrite && existsSync(dest)) throw new FileError(`${name} already exists here`, 409);
  await mkdir(dir, {recursive: true});
  const tmp = `${dest}.rein-upload-${process.pid}`;
  try {
    await pipeline(body, createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, {force: true});
    throw err;
  }
  return dest;
}

export const download = (file: string) => createReadStream(file);

export async function mkdirp(dir: string): Promise<void> {
  if (existsSync(dir)) throw new FileError(`${path.basename(dir)} already exists`, 409);
  await mkdir(dir, {recursive: true});
}

/** Rename or move; refuses to replace something that's there. */
export async function move(from: string, to: string): Promise<void> {
  if (!existsSync(from)) throw new FileError(`${from} doesn't exist`, 404);
  if (existsSync(to)) throw new FileError(`${to} already exists`, 409);
  if (to.startsWith(from + path.sep)) throw new FileError("can't move a folder into itself");
  await mkdir(path.dirname(to), {recursive: true});
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Another disk: copy, then remove.
    await cp(from, to, {recursive: true, errorOnExist: true});
    await rm(from, {recursive: true, force: true});
  }
}

export async function copy(from: string, to: string): Promise<void> {
  const s = await stat(from).catch(() => undefined);
  if (!s) throw new FileError(`${from} doesn't exist`, 404);
  if (existsSync(to)) throw new FileError(`${to} already exists`, 409);
  if (to.startsWith(from + path.sep)) throw new FileError("can't copy a folder into itself");
  if (s.isDirectory()) await cp(from, to, {recursive: true, errorOnExist: true});
  else {
    await mkdir(path.dirname(to), {recursive: true});
    await copyFile(from, to);
  }
}

export async function remove(paths: string[]): Promise<void> {
  for (const p of paths) {
    if (p === path.parse(p).root || p === os.homedir()) throw new FileError(`refusing to delete ${p}`);
    await rm(p, {recursive: true, force: true});
  }
}

/** Files under `dir` by name (and, with `content`, by what's in them), with ripgrep; at most 500. */
export async function search(dir: string, q: string, content = false, hidden = false): Promise<{path: string; line?: number; text?: string}[]> {
  if (!q.trim()) return [];
  const rg = await ripgrep();
  if (!rg) throw new FileError('search needs ripgrep, which ships with Rein; reinstall Rein if it is missing', 500);
  const common = ['--color', 'never', ...(hidden ? ['--hidden'] : []), '-g', '!.git', '-g', '!node_modules'];
  if (content) {
    const r = await run(rg, ['-n', '--no-heading', '-F', '-i', '-m', '5', ...common, '--', q, '.'], {cwd: dir, timeoutMs: 30_000}).catch(() => undefined);
    return (r?.stdout ?? '').split(/\r?\n/).filter(Boolean).slice(0, 500).map((l) => {
      const m = l.replace(/^\.[\\/]/, '').match(/^(.*?):(\d+):(.*)$/);
      return m ? {path: path.join(dir, m[1]!), line: Number(m[2]), text: m[3]!.slice(0, 200)} : {path: path.join(dir, l)};
    });
  }
  const r = await run(rg, ['--files', ...common], {cwd: dir, timeoutMs: 30_000}).catch(() => undefined);
  const needle = q.toLowerCase();
  return (r?.stdout ?? '').split(/\r?\n/).filter((f) => f && f.toLowerCase().includes(needle)).slice(0, 500).map((f) => ({path: path.join(dir, f.replace(/^\.[\\/]/, ''))}));
}
