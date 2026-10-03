import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await rename(tmp, file);
}

export async function writeFileSecure(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, {mode: 0o600});
  await rename(tmp, file);
}

/**
 * Read-modify-write a small JSON settings file: read it (missing/invalid → {}), let `update`
 * change it, and write it back atomically (temp file + rename) — no separate exists check.
 */
export function updateJsonFileSync(file: string, update: (data: any) => void): void {
  let data: any = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) ?? {};
  } catch {
    data = {};
  }
  update(data);
  mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}
