import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {parseAllDocuments, parse as parseYaml} from 'yaml';
import {ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';
import {findWorkspace} from '../workspace/index.js';

/**
 * Service dependency graph (/services): which service calls which, from what the repos say about
 * themselves — docker-compose and Kubernetes config, the API contracts each one provides (OpenAPI,
 * protobuf), gRPC clients, URLs to other services in config and code, and internal package
 * dependencies. Services are the repos of a workspace, or a monorepo's service folders.
 */
export type Service = {name: string; dir: string; provides: string[]};
export type EdgeKind = 'compose' | 'kubernetes' | 'http' | 'grpc' | 'package';
export type Edge = {from: string; to: string; kind: EdgeKind; evidence: string};
export type ServiceGraph = {services: Service[]; edges: Edge[]};

const SERVICE_ROOTS = ['services', 'apps', 'packages', 'cmd', 'svc', 'microservices'];
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};
const rel = (root: string, f: string) => path.relative(root, f).split(path.sep).join('/');

/** The services: a workspace's repos, else the folders under services/, apps/… (each with its own manifest or Dockerfile). */
export function findServices(root: string): Service[] {
  const ws = findWorkspace(root);
  if (ws && ws.repos.filter((r) => r.present).length > 1) return ws.repos.filter((r) => r.present).map((r) => ({name: r.name, dir: r.path, provides: []}));
  const out: Service[] = [];
  for (const top of SERVICE_ROOTS) {
    const d = path.join(root, top);
    if (!isDir(d)) continue;
    for (const name of readdirSync(d)) {
      const dir = path.join(d, name);
      if (!isDir(dir) || name.startsWith('.')) continue;
      if (['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Dockerfile', 'requirements.txt'].some((m) => existsSync(path.join(dir, m)))) out.push({name, dir, provides: []});
    }
  }
  return out.length ? out : [{name: path.basename(root), dir: root, provides: []}];
}

async function files(dir: string, globs: string[]): Promise<string[]> {
  const rg = await ripgrep();
  if (!rg) return [];
  const r = await run(rg, ['--files', '--color', 'never', ...globs.flatMap((g) => ['-g', g])], {cwd: dir, timeoutMs: 30_000}).catch(() => undefined);
  return (r?.stdout ?? '').split(/\r?\n/).filter(Boolean).map((f) => path.join(dir, f));
}

/** Names a service can be called by: its name, and variants (orders-service, orders_api…). */
function aliases(s: Service): string[] {
  const base = s.name.toLowerCase().replace(/[-_](service|svc|api|server|app)$/, '');
  return [...new Set([s.name.toLowerCase(), base, `${base}-service`, `${base}_service`, `${base}-api`, `${base}-svc`])];
}

export async function buildGraph(root: string): Promise<ServiceGraph> {
  const services = findServices(root);
  const edges: Edge[] = [];
  const add = (e: Edge) => {
    if (e.from !== e.to && !edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind)) edges.push(e);
  };
  const byAlias = new Map<string, string>();
  for (const s of services) for (const a of aliases(s)) byAlias.set(a, s.name);
  const owner = (file: string) => services.filter((s) => file === s.dir || file.startsWith(s.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0]?.name;
  const top = findWorkspace(root)?.root ?? root;

  // What each service provides: its contracts.
  for (const s of services) {
    for (const f of await files(s.dir, ['**/openapi*.{yaml,yml,json}', '**/swagger*.{yaml,yml,json}', '**/*.proto', '**/*.graphql'])) {
      const text = read(f) ?? '';
      if (f.endsWith('.proto')) for (const m of text.matchAll(/^\s*service\s+(\w+)/gm)) s.provides.push(`grpc ${m[1]}`);
      else if (/\.(?:graphql)$/.test(f)) s.provides.push(`graphql ${rel(s.dir, f)}`);
      else s.provides.push(`http ${rel(s.dir, f)}`);
    }
  }
  const grpcOwner = new Map<string, string>();
  for (const s of services) for (const p of s.provides) if (p.startsWith('grpc ')) grpcOwner.set(p.slice(5), s.name);

  // docker-compose: depends_on and links between services that are ours.
  for (const f of await files(top, ['**/{docker-,}compose*.{yml,yaml}'])) {
    let doc: any;
    try {
      doc = parseYaml(read(f) ?? '');
    } catch {
      continue;
    }
    for (const [name, def] of Object.entries<any>(doc?.services ?? {})) {
      const from = byAlias.get(name.toLowerCase());
      if (!from) continue;
      const deps = Array.isArray(def?.depends_on) ? def.depends_on : Object.keys(def?.depends_on ?? {});
      for (const d of [...deps, ...(def?.links ?? []).map((l: string) => l.split(':')[0])]) {
        const to = byAlias.get(String(d).toLowerCase());
        if (to) add({from, to, kind: 'compose', evidence: `${rel(top, f)}: ${name} depends on ${d}`});
      }
      for (const v of Object.values<any>(Array.isArray(def?.environment) ? Object.fromEntries(def.environment.map((e: string) => e.split('='))) : def?.environment ?? {})) urlEdge(from, String(v), `${rel(top, f)}: ${name}`, 'compose');
    }
  }

  // URLs naming another service (http://orders:8080, orders.default.svc, grpc://ledger-api), in config and code.
  function urlEdge(from: string, value: string, evidence: string, kind: EdgeKind = 'http') {
    for (const m of value.matchAll(/\b(?:https?|grpcs?|amqp|redis|postgres(?:ql)?):\/\/([a-z0-9][a-z0-9_-]*)(?:\.[a-z0-9.-]*)?(?::\d+)?/gi)) {
      const to = byAlias.get(m[1]!.toLowerCase());
      if (to) add({from, to, kind, evidence});
    }
    for (const m of value.matchAll(/\b([a-z0-9][a-z0-9-]*)\.[a-z0-9-]+\.svc(?:\.cluster\.local)?\b/gi)) {
      const to = byAlias.get(m[1]!.toLowerCase());
      if (to) add({from, to, kind: kind === 'compose' ? 'kubernetes' : kind, evidence});
    }
  }

  for (const s of services) {
    // Kubernetes manifests and Helm values: env values with service hosts.
    for (const f of await files(s.dir, ['**/*.{yaml,yml}', '!**/node_modules/**'])) {
      const text = read(f) ?? '';
      if (!/\b(?:kind:\s*(?:Deployment|StatefulSet|Service|ConfigMap|CronJob|Job)|env:|values)/.test(text) && !/values.*\.ya?ml$/.test(f)) continue;
      try {
        for (const d of parseAllDocuments(text)) urlEdge(s.name, JSON.stringify(d.toJSON() ?? {}), rel(top, f), /kind:/.test(text) ? 'kubernetes' : 'http');
      } catch {}
    }
    // Code and .env files: URLs, *_URL variables named after a service, and gRPC clients.
    for (const f of await files(s.dir, ['**/*.{ts,tsx,js,mjs,py,go,java,kt,rb,cs}', '**/.env*', '**/*.{env,properties,toml}', '!**/node_modules/**', '!**/vendor/**', '!**/*.{test,spec}.*'])) {
      const text = read(f) ?? '';
      if (text.length > 400_000) continue;
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const where = `${rel(top, f)}:${i + 1}`;
        if (/:\/\/|\.svc\b/.test(line)) urlEdge(s.name, line, where);
        for (const m of line.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*?)_(?:SERVICE_)?(?:URL|HOST|ADDR|ADDRESS|ENDPOINT|BASE_URL)\b/g)) {
          const to = byAlias.get(m[1]!.toLowerCase().replace(/_/g, '-')) ?? byAlias.get(m[1]!.toLowerCase());
          if (to) add({from: s.name, to, kind: 'http', evidence: `${where} (${m[0]})`});
        }
        for (const m of line.matchAll(/\b(?:New|new\s+)?(\w+?)(?:Client|Stub|BlockingStub|FutureStub)\s*\(/g)) {
          const to = grpcOwner.get(m[1]!);
          if (to) add({from: s.name, to, kind: 'grpc', evidence: `${where} (${m[1]} client)`});
        }
      });
    }
    // Internal packages: a dependency on another service's package name.
    const pkg = read(path.join(s.dir, 'package.json'));
    if (pkg) {
      try {
        const deps = Object.keys({...JSON.parse(pkg).dependencies, ...JSON.parse(pkg).devDependencies});
        for (const o of services) {
          const name = (() => {
            try {
              return JSON.parse(read(path.join(o.dir, 'package.json')) ?? '{}').name as string | undefined;
            } catch {
              return undefined;
            }
          })();
          if (o !== s && name && deps.includes(name)) add({from: s.name, to: o.name, kind: 'package', evidence: `${rel(top, path.join(s.dir, 'package.json'))}: depends on ${name}`});
        }
      } catch {}
    }
    const gomod = read(path.join(s.dir, 'go.mod'));
    if (gomod)
      for (const o of services) {
        const mod = read(path.join(o.dir, 'go.mod'))?.match(/^module\s+(\S+)/m)?.[1];
        if (o !== s && mod && new RegExp(`^\\s*(?:require\\s+)?${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm').test(gomod)) add({from: s.name, to: o.name, kind: 'package', evidence: `${rel(top, path.join(s.dir, 'go.mod'))}: requires ${mod}`});
      }
  }
  return {services, edges};
}

export function formatGraph(g: ServiceGraph): string {
  if (g.services.length < 2) return 'Only one service here: no graph to draw. In a workspace (rein.workspace.yaml) or a monorepo with services/ or apps/, /services shows who calls whom.';
  const lines = [`${g.services.length} services, ${g.edges.length} dependencies:`];
  for (const s of g.services) {
    const out = g.edges.filter((e) => e.from === s.name);
    const inc = g.edges.filter((e) => e.to === s.name);
    lines.push(`  ${s.name}${s.provides.length ? `  (provides ${s.provides.slice(0, 4).join(', ')}${s.provides.length > 4 ? ', …' : ''})` : ''}`);
    for (const e of out) lines.push(`    → ${e.to}  [${e.kind}] ${e.evidence}`);
    if (!out.length && !inc.length) lines.push('    (no dependencies found)');
  }
  return lines.join('\n');
}

/** Mermaid, for docs and PRs (GitHub renders it). */
export function mermaid(g: ServiceGraph): string {
  const id = (n: string) => n.replace(/[^\w]/g, '_');
  return ['```mermaid', 'graph LR', ...g.services.map((s) => `  ${id(s.name)}["${s.name}"]`), ...g.edges.map((e) => `  ${id(e.from)} -->|${e.kind}| ${id(e.to)}`), '```'].join('\n');
}

/** Who calls a service, and whom it calls (for the agent's service_graph tool and /impact). */
export function neighbours(g: ServiceGraph, name: string): {callers: Edge[]; callees: Edge[]} {
  return {callers: g.edges.filter((e) => e.to === name), callees: g.edges.filter((e) => e.from === name)};
}
