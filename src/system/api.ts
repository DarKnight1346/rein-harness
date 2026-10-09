import {readFileSync} from 'node:fs';
import path from 'node:path';
import {ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';
import {findWorkspace} from '../workspace/index.js';
import type {Service} from './services.js';

/**
 * API-aware find references (/refs, api_refs): follow an endpoint (`POST /orders/{id}`) or an RPC
 * (`Ledger.Post`) across repos — the gateway route in front of it, the service that serves it (its
 * OpenAPI path and route registration), and every call site in the other services.
 */
export type Place = {service: string; file: string; line: number; text: string};
export type ApiRefs = {target: string; gateways: Place[]; providers: Place[]; consumers: Place[]};

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** `POST /orders/{id}` → method and path segments (params as null). */
export function parseEndpoint(s: string): {method?: string; segments: (string | null)[]} | undefined {
  const m = s.trim().match(/^(?:([A-Za-z]+)\s+)?(\/\S*)$/);
  if (!m) return undefined;
  const method = m[1]?.toLowerCase();
  if (method && !METHODS.includes(method)) return undefined;
  const segments = m[2]!.split('/').filter(Boolean).map((p) => (/^(?:\{[^}]+\}|:\w+|<[^>]+>|\*)$/.test(p) ? null : p));
  return {...(method ? {method} : {}), segments};
}

/** A path as it appears in code, whatever the param syntax: /orders/${id}, /orders/{id}, /orders/:id, '/orders/' + id. */
export function pathPattern(segments: (string | null)[]): RegExp {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const param = String.raw`(?:\$\{[^}]+\}|\{[^}]+\}|:[A-Za-z_]\w*|<[^>]+>|%[sd]|['"\`]\s*\+\s*[\w.()[\]]+(?:\s*\+\s*['"\`])?|[\w-]+)`;
  const body = segments.map((s) => (s === null ? param : esc(s))).join('/');
  // Ends at the path's end, a query string, a quote, or a param that ends the string.
  return new RegExp(`/${body}(?=$|[?'"\`)\\s#:]|/?['"\`])`);
}

const CALL_METHOD = /\b(?:fetch|axios|got|ky|request|http|client|requests|httpx|session|api|\$http)\b[^\n]{0,60}?\.?(get|post|put|patch|delete)\b|method\s*[:=]\s*['"](GET|POST|PUT|PATCH|DELETE)['"]|\b(Get|Post|Put|Patch|Delete)(?:Async)?\(/i;
const ROUTE_DEF = /\b(?:app|router|routes|route|r|e|g|api|server|fastify|bp|blueprint|mux|v\d)\.(?:get|post|put|patch|delete|all|route|use)\(\s*['"`]|@(?:app|router|api|bp|blueprint)\.(?:get|post|put|patch|delete|route)\(|@(?:Get|Post|Put|Patch|Delete|Request)Mapping\(|HandleFunc\(|\.(?:GET|POST|PUT|PATCH|DELETE|Handle)\(/;

async function grep(dir: string, needle: string, ignoreCase = false): Promise<{file: string; line: number; text: string}[]> {
  const rg = await ripgrep();
  if (!rg) return [];
  const r = await run(rg, ['-n', '--no-heading', '--color', 'never', '-F', ...(ignoreCase ? ['-i'] : []), '-g', '!**/node_modules/**', '-g', '!**/vendor/**', '-g', '!**/dist/**', '-g', '!**/*.{lock,map,min.js}', '--', needle, '.'], {cwd: dir, timeoutMs: 60_000}).catch(() => undefined);
  return (r?.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.match(/^(.*?):(\d+):(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({file: m[1]!.replace(/^\.\//, '').replace(/\\/g, '/'), line: Number(m[2]), text: m[3]!.trim().slice(0, 200)}));
}

export async function findApiRefs(root: string, services: Service[], target: string): Promise<ApiRefs | undefined> {
  const rpc = target.match(/^(\w+)[./](\w+)$/);
  if (rpc && !target.startsWith('/')) return findRpcRefs(services, rpc[1]!, rpc[2]!, target);
  const ep = parseEndpoint(target);
  if (!ep) return undefined;
  const re = pathPattern(ep.segments);
  const literal = ep.segments.slice(0, ep.segments.indexOf(null) < 0 ? undefined : ep.segments.indexOf(null)).join('/');
  const needle = `/${literal}`;
  const out: ApiRefs = {target, gateways: [], providers: [], consumers: []};
  const top = findWorkspace(root)?.root ?? root;
  for (const s of services) {
    for (const hit of await grep(s.dir, needle)) {
      if (!re.test(hit.text)) continue;
      const place = {service: s.name, file: path.relative(top, path.join(s.dir, hit.file)).split(path.sep).join('/'), line: hit.line, text: hit.text};
      const f = hit.file;
      const m = hit.text.match(CALL_METHOD);
      // fetch(url) with no options is a GET; fetch(url, {…}) on several lines stays unknown (kept).
      const method = (m?.[1] ?? m?.[2] ?? m?.[3])?.toLowerCase() ?? (/\bfetch\s*\([^,]*\)/.test(hit.text) && !/\bmethod\b/.test(hit.text) ? 'get' : undefined); // one argument, no options: a GET
      if (/\.(?:ya?ml|json)$/.test(f) && /openapi|swagger/i.test(f + readHead(path.join(s.dir, f)))) out.providers.push(place);
      else if (/(?:^|\/)(?:nginx|ingress|gateway|kong|envoy|traefik)|\.conf$/i.test(f) || /^\s*location\s/.test(hit.text) || /\bpath:\s/.test(hit.text)) out.gateways.push(place);
      else if (ROUTE_DEF.test(hit.text)) out.providers.push(place);
      else if (/\.(?:md|txt|rst)$/.test(f) || /(?:^|\/)(?:docs?|tests?|__tests__)\//.test(f)) continue;
      else if (!ep.method || !method || method === ep.method) out.consumers.push(place);
    }
  }
  // A provider whose route is called from its own service isn't a consumer of itself.
  const providerServices = new Set(out.providers.map((p) => p.service));
  out.consumers = out.consumers.filter((c) => !providerServices.has(c.service) || !ROUTE_DEF.test(c.text));
  return sorted(out);
}

/** In a stable order (ripgrep lists files in no particular one). */
const byPlace = (a: Place, b: Place) => a.service.localeCompare(b.service) || a.file.localeCompare(b.file) || a.line - b.line;
const sorted = (r: ApiRefs): ApiRefs => ({...r, gateways: r.gateways.sort(byPlace), providers: r.providers.sort(byPlace), consumers: r.consumers.sort(byPlace)});

const readHead = (f: string) => {
  try {
    return readFileSync(f, 'utf8').slice(0, 200);
  } catch {
    return '';
  }
};

/** gRPC: the service owning `service Ledger`, its implementation of the method, and the clients that call it. */
async function findRpcRefs(services: Service[], svc: string, method: string, target: string): Promise<ApiRefs> {
  const out: ApiRefs = {target, gateways: [], providers: [], consumers: []};
  for (const s of services) {
    const owns = s.provides.includes(`grpc ${svc}`);
    for (const hit of await grep(s.dir, method, true)) {
      const word = new RegExp(`\\b${method}\\b`, 'i');
      if (!word.test(hit.text)) continue;
      const place = {service: s.name, file: hit.file, line: hit.line, text: hit.text};
      if (hit.file.endsWith('.proto')) {
        if (/\brpc\s/.test(hit.text)) out.providers.push(place);
      } else if (owns && /\bfunc\s*\(|\bdef\s|\bpublic\s|\basync\s+\w+\(|override|implements|Servicer|Server\b/.test(hit.text)) out.providers.push(place);
      else if (!owns && new RegExp(`\\.${method}\\s*\\(|\\.${method[0]!.toLowerCase()}${method.slice(1)}\\s*\\(`).test(hit.text)) {
        // Only in files that talk to this service's client.
        const text = readHead(path.join(s.dir, hit.file)) + (await readAll(path.join(s.dir, hit.file)));
        if (new RegExp(`\\b${svc}(?:Client|Stub|BlockingStub|FutureStub|Service)\\b`).test(text)) out.consumers.push(place);
      }
    }
  }
  return sorted(out);
}

const readAll = async (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

export function formatRefs(r: ApiRefs): string {
  const list = (title: string, ps: Place[]) => (ps.length ? [`${title}:`, ...ps.slice(0, 40).map((p) => `  ${p.service}  ${p.file}:${p.line}  ${p.text}`), ...(ps.length > 40 ? [`  … ${ps.length - 40} more`] : [])] : [`${title}: none found`]);
  return [`${r.target}`, ...list('Gateway', r.gateways), ...list('Served by', r.providers), ...list('Called from', r.consumers)].join('\n');
}
