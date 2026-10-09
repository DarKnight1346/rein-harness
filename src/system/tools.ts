import type {ToolDef} from '../tools/registry.js';
import {buildGraph, formatGraph, neighbours, type ServiceGraph} from './services.js';

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
