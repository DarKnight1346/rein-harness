import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {ownersOf} from '../context/owners.js';
import {repoMap} from '../context/repoMap.js';
import {run} from '../util/proc.js';
import {mermaid, type ServiceGraph} from './services.js';

/**
 * Codemaps (/codemap): an architecture map you can browse and commit, in docs/codemap/ — an index
 * with the service graph (Mermaid), and a page per service: what it provides, what it calls and what
 * calls it, its owners, its main folders and key declarations. Each page keeps a notes section that
 * regeneration never touches (`/codemap annotate` has the agent write them), and a hash per service
 * says which pages are stale.
 */
export const codemapDir = (root: string) => path.join(root, 'docs', 'codemap');
const NOTES_START = '<!-- rein:notes -->';
const NOTES_END = '<!-- /rein:notes -->';
const EMPTY_NOTES = '_What this service is for, how it works, what to watch out for. Run `/codemap annotate` to have the agent write it, or write it yourself: regenerating keeps it._';
const manifest = (root: string) => path.join(codemapDir(root), '.codemap.json');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'service';

/** What a service's page is built from: its files' paths and sizes (cheap, and changes with any edit). */
async function serviceHash(dir: string): Promise<string> {
  const listed = (await run('git', ['ls-files', '-s'], {cwd: dir, timeoutMs: 60_000}).catch(() => undefined))?.stdout;
  if (listed) return createHash('sha1').update(listed).digest('hex').slice(0, 16);
  const h = createHash('sha1');
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    for (const e of readdirSync(d, {withFileTypes: true})) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else h.update(`${f}:${statSync(f).size}:${statSync(f).mtimeMs}`);
    }
  };
  walk(dir, 0);
  return h.digest('hex').slice(0, 16);
}

function folders(dir: string): {name: string; files: number}[] {
  const count = (d: string, depth = 0): number => {
    let n = 0;
    try {
      for (const e of readdirSync(d, {withFileTypes: true})) {
        if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'vendor', 'target'].includes(e.name)) continue;
        n += e.isDirectory() ? (depth < 8 ? count(path.join(d, e.name), depth + 1) : 0) : 1;
      }
    } catch {}
    return n;
  };
  try {
    return readdirSync(dir, {withFileTypes: true})
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'dist', 'build', 'vendor', 'target', 'coverage'].includes(e.name))
      .map((e) => ({name: e.name, files: count(path.join(dir, e.name))}))
      .filter((f) => f.files)
      .sort((a, b) => b.files - a.files)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function entryPoints(dir: string): string[] {
  const out: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.main) out.push(pkg.main);
    if (typeof pkg.bin === 'string') out.push(pkg.bin);
    else if (pkg.bin) out.push(...Object.values<string>(pkg.bin));
    if (pkg.scripts?.start) out.push(`npm start: ${pkg.scripts.start}`);
  } catch {}
  for (const f of ['main.go', 'cmd', 'src/main.ts', 'src/index.ts', 'src/server.ts', 'app.py', 'main.py', 'manage.py', '__main__.py', 'src/main.rs', 'Dockerfile']) if (existsSync(path.join(dir, f))) out.push(f);
  return [...new Set(out)];
}

const keptNotes = (file: string) => {
  try {
    const t = readFileSync(file, 'utf8');
    const i = t.indexOf(NOTES_START);
    const j = t.indexOf(NOTES_END);
    return i >= 0 && j > i ? t.slice(i + NOTES_START.length, j).trim() : undefined;
  } catch {
    return undefined;
  }
};

export type CodemapResult = {written: string[]; unchanged: string[]; dir: string};

/** Write (or refresh) docs/codemap/: only the services whose files changed since the last run, plus the index. */
export async function writeCodemap(root: string, g: ServiceGraph, opts: {force?: boolean} = {}): Promise<CodemapResult> {
  const dir = codemapDir(root);
  mkdirSync(dir, {recursive: true});
  let hashes: Record<string, string> = {};
  try {
    hashes = JSON.parse(readFileSync(manifest(root), 'utf8'));
  } catch {}
  const written: string[] = [];
  const unchanged: string[] = [];
  const relOf = (p: string) => path.relative(root, p).split(path.sep).join('/') || '.';
  for (const s of g.services) {
    const file = path.join(dir, `${slug(s.name)}.md`);
    const hash = `${await serviceHash(s.dir)}:${g.edges.filter((e) => e.from === s.name || e.to === s.name).length}`;
    if (!opts.force && hashes[s.name] === hash && existsSync(file)) {
      unchanged.push(s.name);
      continue;
    }
    const map = await repoMap(s.dir, 1200).catch(() => undefined);
    // Declared owners only (CODEOWNERS, Backstage); commit counts aren't ownership.
    const owners = [...new Set((await ownersOf(root, [relOf(s.dir)]).catch(() => [])).flatMap((o) => (o.source === 'git history' ? [] : o.owners)))];
    const calls = g.edges.filter((e) => e.from === s.name);
    const calledBy = g.edges.filter((e) => e.to === s.name);
    const entries = entryPoints(s.dir);
    const page = [
      `# ${s.name}`,
      '',
      `\`${relOf(s.dir)}\`${owners.length ? ` · owned by ${owners.join(', ')}` : ''}`,
      '',
      '## Notes',
      '',
      NOTES_START,
      keptNotes(file) ?? EMPTY_NOTES,
      NOTES_END,
      '',
      '## Provides',
      '',
      ...(s.provides.length ? s.provides.map((p) => `- ${p}`) : ['_No API contract found (OpenAPI, protobuf, GraphQL)._']),
      '',
      '## Calls',
      '',
      ...(calls.length ? calls.map((e) => `- [${e.to}](${slug(e.to)}.md) (${e.kind}): ${e.evidence}`) : ['_Nothing found._']),
      '',
      '## Called by',
      '',
      ...(calledBy.length ? calledBy.map((e) => `- [${e.from}](${slug(e.from)}.md) (${e.kind}): ${e.evidence}`) : ['_Nothing found._']),
      '',
      '## Entry points',
      '',
      ...(entries.length ? entries.map((f) => `- \`${f}\``) : ['_None found._']),
      '',
      '## Layout',
      '',
      ...folders(s.dir).map((f) => `- \`${f.name}/\` (${f.files} files)`),
      '',
      ...(map?.shown ? ['## Key declarations', '', '```text', map.text.trim(), '```', ''] : []),
      `<sub>Generated by Rein's /codemap. Everything except the notes is regenerated.</sub>`,
      '',
    ].join('\n');
    writeFileSync(file, page);
    hashes[s.name] = hash;
    written.push(s.name);
  }
  const index = [
    '# Codemap',
    '',
    `${g.services.length} services and how they depend on each other. Each page has the service's APIs, callers, owners and layout.`,
    '',
    mermaid(g),
    '',
    '| Service | Provides | Calls | Called by |',
    '| --- | --- | --- | --- |',
    ...g.services.map((s) => `| [${s.name}](${slug(s.name)}.md) | ${s.provides.length ? s.provides.slice(0, 3).join(', ') : '—'} | ${[...new Set(g.edges.filter((e) => e.from === s.name).map((e) => e.to))].join(', ') || '—'} | ${[...new Set(g.edges.filter((e) => e.to === s.name).map((e) => e.from))].join(', ') || '—'} |`),
    '',
    '<sub>Generated by Rein\'s /codemap.</sub>',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'README.md'), index);
  writeFileSync(manifest(root), JSON.stringify(hashes, null, 2) + '\n');
  return {written, unchanged, dir};
}

/** Which pages are out of date (their service changed since the map was written), and which have no notes yet. */
export async function codemapStatus(root: string, g: ServiceGraph): Promise<{stale: string[]; missing: string[]; unannotated: string[]}> {
  let hashes: Record<string, string> = {};
  try {
    hashes = JSON.parse(readFileSync(manifest(root), 'utf8'));
  } catch {}
  const stale: string[] = [];
  const missing: string[] = [];
  const unannotated: string[] = [];
  for (const s of g.services) {
    const file = path.join(codemapDir(root), `${slug(s.name)}.md`);
    if (!existsSync(file)) {
      missing.push(s.name);
      continue;
    }
    const hash = `${await serviceHash(s.dir)}:${g.edges.filter((e) => e.from === s.name || e.to === s.name).length}`;
    if (hashes[s.name] !== hash) stale.push(s.name);
    if ((keptNotes(file) ?? EMPTY_NOTES) === EMPTY_NOTES) unannotated.push(s.name);
  }
  return {stale, missing, unannotated};
}

/** The task for `/codemap annotate`: write the notes of each page that has none. */
export function annotateTask(root: string, services: string[]): string {
  const rel = path.relative(process.cwd(), codemapDir(root)).split(path.sep).join('/') || 'docs/codemap';
  return [
    `Write the Notes section of these codemap pages in ${rel}/: ${services.map((s) => `${slug(s)}.md`).join(', ')}.`,
    `For each, read the service (its entry points, main modules and APIs, listed on the page) and write 3–6 sentences between ${NOTES_START} and ${NOTES_END}: what it's for, how a request moves through it, what it depends on and why, and anything surprising a newcomer should know. Replace only the text between the markers; the rest of each page is generated.`,
  ].join('\n\n');
}
