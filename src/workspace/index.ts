import {existsSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {run} from '../util/proc.js';

/**
 * A workspace: several repos worked on as one system, declared in `rein.workspace.yaml` in a folder
 * above (or at) the launch folder. Its repos become working directories, the system prompt lists them
 * with their roles, and the AGENTS.md / CLAUDE.md next to the manifest apply to all of them.
 */
export interface WorkspaceRepo {
  name: string;
  /** Absolute path. */
  path: string;
  /** Git URL, for `/workspace clone` when the folder isn't there yet. */
  url?: string;
  /** What the repo is in the system (free text: "API gateway", "provider of the orders API"). */
  role?: string;
  /** The repo's default branch. */
  branch?: string;
  present: boolean;
}

export interface Workspace {
  root: string;
  file: string;
  name?: string;
  repos: WorkspaceRepo[];
  /** Problems in the manifest, reported once at startup and by /workspace. */
  errors: string[];
}

export const WORKSPACE_FILES = ['rein.workspace.yaml', 'rein.workspace.yml'];

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function parseWorkspace(file: string, text: string): Workspace {
  const root = path.dirname(file);
  const ws: Workspace = {root, file, repos: [], errors: []};
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    ws.errors.push(`${path.basename(file)}: ${(err as Error).message.split('\n')[0]}`);
    return ws;
  }
  if (!doc || typeof doc !== 'object') return ws;
  const d = doc as Record<string, unknown>;
  ws.name = str(d.name);
  const list = Array.isArray(d.repos) ? d.repos : d.repos && typeof d.repos === 'object' ? Object.entries(d.repos).map(([name, v]) => ({name, ...(v as object)})) : [];
  for (const [i, raw] of list.entries()) {
    const r = (typeof raw === 'string' ? {path: raw} : raw) as Record<string, unknown>;
    const rel = str(r?.path) ?? (str(r?.name) ? str(r.name) : undefined);
    if (!rel) {
      ws.errors.push(`repos[${i}]: needs a path (or a name, used as the folder)`);
      continue;
    }
    const abs = path.resolve(root, rel.startsWith('~/') ? path.join(process.env.HOME ?? '', rel.slice(2)) : rel);
    const name = str(r.name) ?? path.basename(abs);
    if (ws.repos.some((x) => x.name === name)) {
      ws.errors.push(`repos[${i}]: the name "${name}" is used twice`);
      continue;
    }
    let present = false;
    try {
      present = statSync(abs).isDirectory();
    } catch {}
    ws.repos.push({name, path: abs, url: str(r.url), role: str(r.role), branch: str(r.branch), present});
  }
  return ws;
}

/** The workspace the folder belongs to: the nearest `rein.workspace.yaml` at or above it. */
export function findWorkspace(cwd = process.cwd()): Workspace | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const f of WORKSPACE_FILES) {
      const file = path.join(dir, f);
      if (existsSync(file)) {
        let text = '';
        try {
          text = readFileSync(file, 'utf8');
        } catch {}
        return parseWorkspace(file, text);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The workspace repos to add as working directories: present ones other than the launch folder's own. */
export function workspaceDirs(ws: Workspace | undefined, cwd = process.cwd()): string[] {
  if (!ws) return [];
  const here = path.resolve(cwd);
  return ws.repos.filter((r) => r.present && r.path !== here && !here.startsWith(r.path + path.sep)).map((r) => r.path);
}

/** For the system prompt: the repos, where they are and what they do. */
export function describeWorkspace(ws: Workspace, cwd = process.cwd()): string {
  const here = path.resolve(cwd);
  const lines = ws.repos.map((r) => {
    const bits = [r.role, r.branch && `default branch ${r.branch}`, !r.present && 'not cloned yet'].filter(Boolean).join('; ');
    const mine = r.path === here || here.startsWith(r.path + path.sep) ? ' (the launch folder)' : '';
    return `- ${r.name}: ${r.path}${mine}${bits ? ` — ${bits}` : ''}`;
  });
  return [
    `# Workspace${ws.name ? ` "${ws.name}"` : ''} (${ws.file})`,
    'These repos are worked on together as one system. All of them are working directories. A change that crosses repos (an API and its callers, a shared library and its users) should be made in every repo it affects, keeping each repo\'s own conventions. search and list with workspace: true cover every repo in one call.',
    ...lines,
  ].join('\n');
}

/** `/workspace clone`: clone the repos that have a url and aren't there yet. */
export async function cloneMissing(ws: Workspace, onProgress: (line: string) => void = () => {}): Promise<{cloned: string[]; failed: string[]}> {
  const cloned: string[] = [];
  const failed: string[] = [];
  for (const r of ws.repos.filter((x) => !x.present && x.url)) {
    onProgress(`Cloning ${r.name} from ${r.url}…`);
    const res = await run('git', ['clone', ...(r.branch ? ['--branch', r.branch] : []), r.url!, r.path], {cwd: ws.root, timeoutMs: 15 * 60_000});
    if (res.code === 0) {
      r.present = true;
      cloned.push(r.name);
    } else failed.push(`${r.name}: ${(res.stderr || res.stdout).trim().split('\n').pop() ?? 'git clone failed'}`);
  }
  return {cloned, failed};
}
