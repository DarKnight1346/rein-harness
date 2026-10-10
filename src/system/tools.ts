import type {ToolDef} from '../tools/registry.js';
import {buildGraph, findServices, formatGraph, neighbours, type ServiceGraph} from './services.js';
import {buildSymbolGraph, formatLookup, lookup} from './scip.js';
import {findApiRefs, formatRefs} from './api.js';

/** The graph, built once per few minutes (it reads every repo). */
let cached: {root: string; at: number; graph: ServiceGraph} | undefined;
export async function graphFor(root: string, maxAgeMs = 5 * 60_000): Promise<ServiceGraph> {
  if (cached && cached.root === root && Date.now() - cached.at < maxAgeMs) return cached.graph;
  const graph = await buildGraph(root);
  cached = {root, at: Date.now(), graph};
  return graph;
}

/** `service_graph` (experiment system-graph): which service calls which, for the agent. */
export function serviceGraphTool(experiments: () => string[], root: () => string): ToolDef {
  return {
    name: 'service_graph',
    label: 'Services',
    description: '',
    describe: () =>
      "The system's services and who calls whom (from docker-compose, Kubernetes config, URLs and *_URL settings, gRPC clients, internal packages), with the file and line behind each link. Give a service to see its callers and what it calls, or omit it for the whole graph. Use it before changing a service's API, to know who else is affected.",
    inputSchema: {type: 'object', properties: {service: {type: 'string', description: 'A service (repo or folder) name; omit for all'}}},
    mutating: false,
    enabled: () => experiments().includes('system-graph'),
    summarize: (a) => String(a?.service ?? 'all'),
    async run(_ctx, args) {
      const g = await graphFor(root());
      const name = args?.service ? String(args.service) : undefined;
      if (!name) return {ok: true, text: formatGraph(g)};
      const s = g.services.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!s) return {ok: false, text: `no service "${name}"; services: ${g.services.map((x) => x.name).join(', ')}`};
      const {callers, callees} = neighbours(g, s.name);
      return {
        ok: true,
        text: [`${s.name}${s.provides.length ? ` provides ${s.provides.join(', ')}` : ''}`, `Called by:${callers.length ? '' : ' nothing found'}`, ...callers.map((e) => `  ${e.from} [${e.kind}] ${e.evidence}`), `Calls:${callees.length ? '' : ' nothing found'}`, ...callees.map((e) => `  ${e.to} [${e.kind}] ${e.evidence}`)].join('\n'),
      };
    },
  };
}

/** `symbol_refs` (experiment system-graph): where a symbol is defined and used, across repos, from their SCIP indexes. */
export function symbolRefsTool(experiments: () => string[], root: () => string): ToolDef {
  return {
    name: 'symbol_refs',
    label: 'SymbolRefs',
    description: '',
    describe: () =>
      'Where a function, type or constant is defined and every place it is used, across all the repos (from their SCIP indexes, index.scip). Give its name (e.g. formatMoney, OrderStatus). Use it before changing a shared library or API to find callers in other repos.',
    inputSchema: {type: 'object', properties: {name: {type: 'string', description: 'The symbol name'}}, required: ['name']},
    mutating: false,
    enabled: () => experiments().includes('system-graph'),
    summarize: (a) => String(a?.name ?? ''),
    async run(_ctx, args) {
      const g = buildSymbolGraph(findServices(root()));
      if (!g.repos.length) return {ok: false, text: 'no SCIP indexes (index.scip) in these repos: /symbols index writes them where the indexers are installed'};
      return {ok: true, text: formatLookup(lookup(g, String(args?.name ?? '')))};
    },
  };
}

/** `api_refs` (experiment system-graph): follow an endpoint or RPC from the gateway to the service to every caller. */
export function apiRefsTool(experiments: () => string[], root: () => string): ToolDef {
  return {
    name: 'api_refs',
    label: 'ApiRefs',
    description: '',
    describe: () =>
      'Follow an HTTP endpoint ("POST /orders/{id}") or a gRPC method ("Ledger.Post") across every repo: the gateway route in front of it, where it is served (OpenAPI path, route registration or implementation), and every call site in the other services. For a function or type name, use symbol_refs.',
    inputSchema: {type: 'object', properties: {target: {type: 'string', description: 'An endpoint ("GET /users/{id}") or an RPC ("Service.Method")'}}, required: ['target']},
    mutating: false,
    enabled: () => experiments().includes('system-graph'),
    summarize: (a) => String(a?.target ?? ''),
    async run(_ctx, args) {
      const g = await graphFor(root());
      const r = await findApiRefs(root(), g.services, String(args?.target ?? ''));
      if (!r) return {ok: false, text: 'give an endpoint like "POST /orders/{id}" or an RPC like "Ledger.Post"'};
      return {ok: true, text: formatRefs(r)};
    },
  };
}
