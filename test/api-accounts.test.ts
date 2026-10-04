import {describe, expect, it} from 'vitest';
import {accountEnv} from '../src/providers/env.js';
import {parseAuthStatus} from '../src/providers/claude/auth.js';
import {toStatus} from '../src/providers/codex/auth.js';
import type {Account} from '../src/providers/types.js';

const claude = (over: Partial<Account> = {}): Account => ({id: 'claude-1', provider: 'claude', home: '/h/claude-1', imported: false, ...over});

describe('API accounts', () => {
  it("never let the parent shell's keys or backend switches leak into an account", () => {
    const parent = {PATH: '/bin', ANTHROPIC_API_KEY: 'sk-parent', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1', CLOUD_ML_REGION: 'x'};
    const sub = accountEnv(claude(), parent);
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sub.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(sub.CLAUDE_CONFIG_DIR).toBe('/h/claude-1');
  });

  it('give Bedrock / Vertex accounts their own backend settings', () => {
    const bedrock = accountEnv(claude({api: 'bedrock', apiConfig: {region: 'us-east-1', profile: 'work'}}), {PATH: '/bin'});
    expect(bedrock).toMatchObject({CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', AWS_PROFILE: 'work'});
    const vertex = accountEnv(claude({api: 'vertex', apiConfig: {projectId: 'acme-ai', region: 'us-east5'}}), {PATH: '/bin'});
    expect(vertex).toMatchObject({CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'acme-ai', CLOUD_ML_REGION: 'us-east5'});
    expect(vertex.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });

  it('read API logins from the CLIs', () => {
    expect(parseAuthStatus(JSON.stringify({loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', email: 'me@x.com'}))).toEqual({loggedIn: true, email: 'me@x.com', plan: 'API · Console'});
    expect(parseAuthStatus(JSON.stringify({loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock'}))).toEqual({loggedIn: true, plan: 'API · Bedrock'});
    expect(parseAuthStatus(JSON.stringify({loggedIn: true, authMethod: 'claude.ai', email: 'me@x.com', subscriptionType: 'max'}))).toEqual({loggedIn: true, email: 'me@x.com', plan: 'max'});
    expect(toStatus({account: {type: 'apiKey'}})).toEqual({loggedIn: true, plan: 'API · OpenAI'});
  });
});

describe('routing with API accounts', () => {
  it('uses subscriptions first; API accounts only as a fallback (or after them with "always")', async () => {
    const {catalog} = await import('../src/router/catalog.js');
    const {usageStore} = await import('../src/store/usage.js');
    const {acct, CLAUDE_FAKE_MODELS, fakeAdapter, install, reply, tempHome} = await import('./fakes.js');
    usageStore.reset();
    await tempHome([acct('claude', 'sub1'), {...acct('claude', 'api1'), api: 'console'}]);
    install('claude', fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('ok')).adapter);
    await catalog.refresh();
    const ref = {provider: 'claude' as const, model: 'sonnet'};
    catalog.apiAccounts = 'fallback';
    expect(catalog.healthyAccounts(ref, 98).map((a) => a.id)).toEqual(['sub1']);
    catalog.apiAccounts = 'always';
    expect(catalog.healthyAccounts(ref, 98).map((a) => a.id)).toEqual(['sub1', 'api1']);
    catalog.apiAccounts = 'fallback';
    usageStore.coolDown('sub1', Date.now() + 3600_000); // the subscription hit its limit
    expect(catalog.healthyAccounts(ref, 98).map((a) => a.id)).toEqual(['api1']);
  });
});

describe('API account setup checks', () => {
  it('catch Bedrock / Vertex setup problems before the CLI hangs on them', async () => {
    const {cloudSetupProblem} = await import('../src/providers/claude/auth.js');
    const {mkdtempSync, mkdirSync, writeFileSync} = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
    mkdirSync(path.join(home, '.aws'));
    writeFileSync(path.join(home, '.aws', 'config'), '[profile work]\nregion = us-east-1\n');
    const acct = (api: 'bedrock' | 'vertex', apiConfig: object) => ({id: 'c', provider: 'claude' as const, home: null, imported: false, api, apiConfig});
    expect(cloudSetupProblem(acct('bedrock', {region: 'us-east-1', profile: 'work'}), home, {})).toBeUndefined();
    expect(cloudSetupProblem(acct('bedrock', {region: 'us-east-1', profile: 'missing'}), home, {})).toContain('AWS profile "missing"');
    expect(cloudSetupProblem(acct('bedrock', {}), home, {})).toContain('region is required');
    expect(cloudSetupProblem(acct('vertex', {projectId: 'p'}), home, {})).toContain('gcloud auth application-default login');
  });

  it('check an OpenAI key before Codex stores it', async () => {
    const {checkOpenAiKey} = await import('../src/providers/codex/auth.js');
    const status = (code: number) => (async () => new Response('{}', {status: code})) as unknown as typeof fetch;
    expect(await checkOpenAiKey('hello')).toContain("doesn't look like an OpenAI API key");
    expect(await checkOpenAiKey('sk-proj-0123456789abcdefghij', status(401))).toContain('rejected the key');
    expect(await checkOpenAiKey('sk-proj-0123456789abcdefghij', status(200))).toBeUndefined();
  });
});
