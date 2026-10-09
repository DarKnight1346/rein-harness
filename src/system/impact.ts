import path from 'node:path';
import {ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';
import {branchContracts} from '../contracts/changes.js';
import {findApiRefs, type Place} from './api.js';
import {buildSymbolGraph, lookup} from './scip.js';
import type {Service} from './services.js';

/**
 * Consumer impact report (/impact): what this branch changes that other code depends on, and every
 * caller of it in every repo. Endpoints and RPCs come from the contract changes (followed with the
 * API references); exported functions and types from the diff (followed through the SCIP indexes,
 * else a whole-word search in the other services).
 */
export type Impact = {what: string; kind: 'endpoint' | 'rpc' | 'symbol'; breaking: boolean; changes: string[]; callers: Place[]};

const git = async (cwd: string, ...a: string[]) => (await run('git', a, {cwd, timeoutMs: 60_000}).catch(() => undefined))?.stdout ?? '';

/** The endpoint or RPC a contract change belongs to: "GET /orders/{id} 200.total" → GET /orders/{id}; "Orders.List" → RPC. */
export function targetOf(kind: string, where: string): {target: string; kind: 'endpoint' | 'rpc'} | undefined {
  const ep = where.match(/^([A-Z]+) (\/\S*)/);
  if (ep) return {target: `${ep[1]} ${ep[2]}`, kind: 'endpoint'};
  if (kind === 'protobuf' || /\.proto/.test(kind)) {
    const rpc = where.match(/^(\w+)\.(\w+)$/);
    if (rpc) return {target: where, kind: 'rpc'};
  }
  return undefined;
}

/** Exported declarations whose definition lines the diff touches. */
async function changedExports(dir: string, base: string): Promise<{file: string; name: string}[]> {
  const diff = await git(dir, 'diff', '-U0', '--no-color', base, '--', '*.ts', '*.tsx', '*.js', '*.mjs', '*.py', '*.go');
  const out: {file: string; name: string}[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) {
      file = f[1]!;
      continue;
    }
    if (!/^[-+](?![-+])/.test(line)) continue;
    const t = line.slice(1);
    const m =
      t.match(/^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|type|interface|enum)\s+([A-Za-z_$][\w$]*)/) ??
      (file.endsWith('.py') ? t.match(/^(?:def|class)\s+([A-Za-z]\w*)/) : null) ??
      (file.endsWith('.go') ? t.match(/^(?:func\s+(?:\([^)]*\)\s+)?|type\s+)([A-Z]\w*)/) : null);
    if (m && !out.some((x) => x.name === m[1] && x.file === file)) out.push({file, name: m[1]!});
  }
  return out;
}

async function wordUses(dir: string, name: string): Promise<{file: string; line: number; text: string}[]> {
  const rg = await ripgrep();
  if (!rg) return [];
  const r = await run(rg, ['-n', '--no-heading', '--color', 'never', '-w', '-g', '!**/node_modules/**', '-g', '!**/vendor/**', '-g', '!**/dist/**', '--', name, '.'], {cwd: dir, timeoutMs: 60_000}).catch(() => undefined);
  return (r?.stdout ?? '').split(/\r?\n/).map((l) => l.match(/^\.?\/?(.*?):(\d+):(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({file: m[1]!, line: Number(m[2]), text: m[3]!.trim().slice(0, 200)}));
}

export async function impactReport(root: string, services: Service[]): Promise<{items: Impact[]; base: string}> {
  const items: Impact[] = [];
  // Which services the branch changes: the repos of a workspace each have their own diff; a monorepo has one.
  const repos = [...new Set(services.map((s) => s.dir))];
  const tops = new Map<string, string>();
  for (const d of repos) tops.set(d, (await git(d, 'rev-parse', '--show-toplevel')).trim() || d);
  let base = 'HEAD';
  const seenTop = new Set<string>();
  for (const [, top] of tops) {
    if (seenTop.has(top)) continue;
    seenTop.add(top);
    const c = await branchContracts(top);
    base = c.base;
    for (const f of c.files) {
      const kind = f.file.endsWith('.proto') ? 'protobuf' : f.file;
      for (const ch of f.changes) {
        const t = targetOf(kind, ch.where);
        if (!t) continue;
        const item = items.find((i) => i.what === t.target) ?? (items.push({what: t.target, kind: t.kind, breaking: false, changes: [], callers: []}), items[items.length - 1]!);
        item.breaking ||= ch.kind === 'breaking';
        item.changes.push(`${ch.kind === 'breaking' ? '✗' : '✓'} ${ch.where}: ${ch.what}`);
      }
    }
    const mb = (await git(top, 'merge-base', 'HEAD', base === 'HEAD' ? 'HEAD' : base)).trim() || 'HEAD';
    for (const e of await changedExports(top, mb)) {
      if (items.some((i) => i.what === e.name)) continue;
      items.push({what: e.name, kind: 'symbol', breaking: false, changes: [`changed in ${path.relative(root, path.join(top, e.file)).split(path.sep).join('/') || e.file}`], callers: []});
    }
  }
  const symbols = buildSymbolGraph(services);
  for (const item of items) {
    if (item.kind !== 'symbol') {
      const r = await findApiRefs(root, services, item.what);
      item.callers = r?.consumers ?? [];
      continue;
    }
    const home = item.changes[0]!.replace(/^changed in /, '');
    const scip = symbols.repos.length ? lookup(symbols, item.what, 1)[0] : undefined;
    if (scip) item.callers = scip.refs.map((r) => ({service: r.repo, file: r.file, line: r.line, text: ''}));
    else
      for (const s of services) {
        if (path.join(root, home).startsWith(s.dir + path.sep)) continue; // its own service
        for (const u of await wordUses(s.dir, item.what)) item.callers.push({service: s.name, file: path.relative(root, path.join(s.dir, u.file)).split(path.sep).join('/'), line: u.line, text: u.text});
      }
  }
  return {items: items.sort((a, b) => Number(b.breaking) - Number(a.breaking) || b.callers.length - a.callers.length), base};
}

export function formatImpact(r: {items: Impact[]; base: string}): string {
  if (!r.items.length) return `Nothing this branch changes is used elsewhere: no changed endpoints, RPCs or exported symbols (against ${r.base}).`;
  const blocks = r.items.map((i) => {
    const byRepo = new Map<string, Place[]>();
    for (const c of i.callers) byRepo.set(c.service, [...(byRepo.get(c.service) ?? []), c]);
    return [
      `${i.breaking ? '✗ breaking' : '·'} ${i.what}  (${i.callers.length} caller${i.callers.length === 1 ? '' : 's'} in ${byRepo.size} service${byRepo.size === 1 ? '' : 's'})`,
      ...i.changes.slice(0, 6).map((c) => `    ${c}`),
      ...[...byRepo].flatMap(([svc, cs]) => [`    ${svc}:`, ...cs.slice(0, 10).map((c) => `      ${c.file}:${c.line}${c.text ? `  ${c.text}` : ''}`), ...(cs.length > 10 ? [`      … ${cs.length - 10} more`] : [])]),
    ].join('\n');
  });
  const callers = r.items.reduce((n, i) => n + i.callers.length, 0);
  return [`Impact of this branch (against ${r.base}): ${r.items.length} changed thing${r.items.length === 1 ? '' : 's'}, ${callers} caller${callers === 1 ? '' : 's'}`, ...blocks].join('\n\n');
}
