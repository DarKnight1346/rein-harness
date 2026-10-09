import type {Config} from '../store/config.js';
import type {ToolDef} from '../tools/registry.js';

/**
 * Org-wide code search (config `codeSearch`): Sourcegraph (GraphQL API, token from SRC_ACCESS_TOKEN)
 * or Zoekt (its webserver's JSON API), for code in repos that aren't checked out here. The agent
 * gets an `org_search` tool once one is configured.
 */
export type CodeSearchConfig = {type: 'sourcegraph' | 'zoekt'; url: string};
export type Hit = {repo: string; file: string; line: number; text: string};

let fetcher: typeof fetch = (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(20_000)});
/** Tests swap the network for a fake. */
export function setSearchFetch(fn: typeof fetch): void {
  fetcher = fn;
}

const base = (url: string) => url.replace(/\/+$/, '');

async function sourcegraph(cfg: CodeSearchConfig, query: string, max: number): Promise<Hit[]> {
  const token = process.env.SRC_ACCESS_TOKEN;
  const body = {
    query: `query($q: String!) { search(query: $q, version: V3) { results { results { __typename ... on FileMatch { repository { name } file { path } lineMatches { lineNumber preview } } } } } }`,
    variables: {q: `${query} count:${max}`},
  };
  const r = await fetcher(`${base(cfg.url)}/.api/graphql`, {method: 'POST', headers: {'content-type': 'application/json', ...(token ? {authorization: `token ${token}`} : {})}, body: JSON.stringify(body)});
  if (!r.ok) throw new Error(`Sourcegraph answered ${r.status}${r.status === 401 ? ' (set SRC_ACCESS_TOKEN)' : ''}`);
  const j = (await r.json()) as {data?: {search?: {results?: {results?: {__typename: string; repository?: {name: string}; file?: {path: string}; lineMatches?: {lineNumber: number; preview: string}[]}[]}}}; errors?: {message: string}[]};
  if (j.errors?.length) throw new Error(`Sourcegraph: ${j.errors[0]!.message}`);
  return (j.data?.search?.results?.results ?? [])
    .filter((m) => m.__typename === 'FileMatch')
    .flatMap((m) => (m.lineMatches ?? []).map((l) => ({repo: m.repository?.name ?? '?', file: m.file?.path ?? '?', line: l.lineNumber + 1, text: l.preview.trim()})));
}

async function zoekt(cfg: CodeSearchConfig, query: string, max: number): Promise<Hit[]> {
  const r = await fetcher(`${base(cfg.url)}/api/search`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({Q: query, Opts: {MaxDocDisplayCount: max, NumContextLines: 0}})});
  if (!r.ok) throw new Error(`Zoekt answered ${r.status}`);
  const j = (await r.json()) as {Result?: {Files?: {Repository: string; FileName: string; LineMatches?: {LineNumber: number; Line: string}[]}[] | null}};
  const decode = (s: string) => {
    try {
      return Buffer.from(s, 'base64').toString('utf8'); // Zoekt sends line text base64-encoded
    } catch {
      return s;
    }
  };
  return (j.Result?.Files ?? []).flatMap((f) => (f.LineMatches ?? []).map((l) => ({repo: f.Repository, file: f.FileName, line: l.LineNumber, text: decode(l.Line).trim()})));
}

export async function orgSearch(cfg: CodeSearchConfig, query: string, max = 30): Promise<Hit[]> {
  const hits = cfg.type === 'zoekt' ? await zoekt(cfg, query, max) : await sourcegraph(cfg, query, max);
  return hits.slice(0, max);
}

export function formatHits(hits: Hit[]): string {
  if (!hits.length) return 'No matches.';
  return hits.map((h) => `${h.repo}  ${h.file}:${h.line}: ${h.text.slice(0, 200)}`).join('\n');
}

export function orgSearchTool(config: () => Config): ToolDef {
  return {
    name: 'org_search',
    label: 'OrgSearch',
    description: '',
    describe: () => {
      const c = config().codeSearch;
      return `Search code across every repo the organization's ${c?.type === 'zoekt' ? 'Zoekt' : 'Sourcegraph'} indexes (${c?.url}), not just this checkout: who calls an API, how others use a library, where a config key is read. Returns repo, file:line and the line. Query syntax is ${c?.type === 'zoekt' ? "Zoekt's (e.g. `repo:payments lang:go RetryPolicy`)" : "Sourcegraph's (e.g. `repo:^acme/ lang:go RetryPolicy`, `type:symbol`)"}. Use search for the local checkout.`;
    },
    inputSchema: {type: 'object', properties: {query: {type: 'string', description: 'The search query'}, max: {type: 'integer', description: 'Most results (default 30, at most 100)'}}, required: ['query']},
    mutating: false,
    enabled: () => !!config().codeSearch?.url,
    summarize: (a) => String(a?.query ?? '').slice(0, 80),
    async run(_ctx, args) {
      const c = config().codeSearch;
      if (!c?.url) return {ok: false, text: 'no code search server is configured (codeSearch in config)'};
      const hits = await orgSearch(c, String(args?.query ?? ''), Math.min(100, Math.max(1, Number(args?.max) || 30)));
      return {ok: true, text: formatHits(hits)};
    },
  };
}
