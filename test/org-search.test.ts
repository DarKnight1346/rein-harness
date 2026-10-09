import {afterEach, describe, expect, it} from 'vitest';
import {formatHits, orgSearch, orgSearchTool, setSearchFetch} from '../src/context/orgSearch.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const env = process.env.SRC_ACCESS_TOKEN;
afterEach(() => {
  if (env === undefined) delete process.env.SRC_ACCESS_TOKEN;
  else process.env.SRC_ACCESS_TOKEN = env;
});

describe('org-wide code search', () => {
  it('asks Sourcegraph with the token from SRC_ACCESS_TOKEN', async () => {
    process.env.SRC_ACCESS_TOKEN = 'sgp_test';
    let seen: {url: string; auth?: string; q?: string} = {url: ''};
    setSearchFetch((async (url: string, init: RequestInit) => {
      seen = {url, auth: (init.headers as Record<string, string>).authorization, q: JSON.parse(String(init.body)).variables.q};
      return json({data: {search: {results: {results: [{__typename: 'FileMatch', repository: {name: 'github.com/acme/billing'}, file: {path: 'retry.go'}, lineMatches: [{lineNumber: 41, preview: '  policy := RetryPolicy{Max: 3}'}]}]}}}});
    }) as typeof fetch);
    const hits = await orgSearch({type: 'sourcegraph', url: 'https://sg.acme.dev/'}, 'RetryPolicy lang:go');
    expect(seen).toEqual({url: 'https://sg.acme.dev/.api/graphql', auth: 'token sgp_test', q: 'RetryPolicy lang:go count:30'});
    expect(formatHits(hits)).toBe('github.com/acme/billing  retry.go:42: policy := RetryPolicy{Max: 3}');
  });

  it('reads Zoekt results (base64 lines) and reports server errors', async () => {
    setSearchFetch((async () => json({Result: {Files: [{Repository: 'acme/api', FileName: 'main.go', LineMatches: [{LineNumber: 7, Line: Buffer.from('func main() {').toString('base64')}]}]}})) as typeof fetch);
    expect(await orgSearch({type: 'zoekt', url: 'http://zoekt:6070'}, 'func main')).toEqual([{repo: 'acme/api', file: 'main.go', line: 7, text: 'func main() {'}]);
    setSearchFetch((async () => json({}, 401)) as typeof fetch);
    await expect(orgSearch({type: 'sourcegraph', url: 'https://sg'}, 'x')).rejects.toThrow(/401 \(set SRC_ACCESS_TOKEN\)/);
  });

  it('gives the agent org_search only once a server is configured', () => {
    let cfg: any = {};
    const t = orgSearchTool(() => cfg);
    expect(t.enabled!()).toBe(false);
    cfg = {codeSearch: {type: 'zoekt', url: 'http://zoekt:6070'}};
    expect(t.enabled!()).toBe(true);
    expect(t.describe!()).toMatch(/Zoekt indexes \(http:\/\/zoekt:6070\)/);
  });
});
