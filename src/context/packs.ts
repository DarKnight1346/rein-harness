import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parse, stringify} from 'yaml';
import {globToRegExp, ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';

/**
 * Context packs (/pack): named bundles of files you keep handing the agent ("the payments flow":
 * its services, schemas and docs), in .rein/packs.yaml. `/pack payments` attaches them all, like
 * typing each @path.
 */
export type Pack = {name: string; files: string[]; note?: string};
export const MAX_PACK_FILES = 40;

const file = (root: string) => path.join(root, '.rein', 'packs.yaml');

export function loadPacks(root: string): {packs: Pack[]; error?: string} {
  let text = '';
  try {
    text = readFileSync(file(root), 'utf8');
  } catch {
    return {packs: []};
  }
  try {
    const doc = (parse(text) ?? {}) as Record<string, {files?: unknown; note?: unknown} | unknown[]>;
    const packs = Object.entries(doc).map(([name, v]) => {
      const files = Array.isArray(v) ? v : Array.isArray((v as {files?: unknown})?.files) ? ((v as {files: unknown[]}).files) : [];
      const note = !Array.isArray(v) && typeof (v as {note?: unknown})?.note === 'string' ? ((v as {note: string}).note) : undefined;
      return {name, files: files.map(String), ...(note ? {note} : {})};
    });
    return {packs};
  } catch (err) {
    return {packs: [], error: `.rein/packs.yaml: ${(err as Error).message.split('\n')[0]}`};
  }
}

export function savePack(root: string, pack: Pack): void {
  const {packs} = loadPacks(root);
  const all = Object.fromEntries([...packs.filter((p) => p.name !== pack.name), pack].map((p) => [p.name, {files: p.files, ...(p.note ? {note: p.note} : {})}]));
  mkdirSync(path.dirname(file(root)), {recursive: true});
  writeFileSync(file(root), stringify(all));
}

/** The project files a pack names (globs against the files git doesn't ignore), at most MAX_PACK_FILES. */
export async function packFiles(root: string, pack: Pack): Promise<{files: string[]; more: number}> {
  const rg = await ripgrep();
  const listed = rg ? ((await run(rg, ['--files', '--color', 'never'], {cwd: root, timeoutMs: 20_000}).catch(() => undefined))?.stdout ?? '') : '';
  const all = listed.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  const res = pack.files.map((g) => globToRegExp(g.replace(/^\.\//, '')));
  const hits = all.filter((f) => res.some((re) => re.test(f)));
  return {files: hits.slice(0, MAX_PACK_FILES), more: Math.max(0, hits.length - MAX_PACK_FILES)};
}

/** The message that loads a pack: its files as @mentions (attached when sent), then what you asked. */
export function packMessage(pack: Pack, files: string[], ask: string): string {
  return [`Context pack "${pack.name}"${pack.note ? ` (${pack.note})` : ''}: ${files.map((f) => `@${f}`).join(' ')}`, ask || 'Read these for context; say briefly what they cover and wait for my next message.'].join('\n\n');
}
