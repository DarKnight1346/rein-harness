import {mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {approveProjectServer, loadServers} from '../src/mcp/config.js';
import {McpManager, mcpToolName} from '../src/mcp/manager.js';
import {ToolHost, type ApprovalRequest} from '../src/tools/host.js';

const fixture = path.resolve('test/fixtures/mcp-server.mjs');
let root: string;
let mcp: McpManager | undefined;
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_CLAUDE_SETTINGS = path.join(process.env.REIN_HOME, 'none.json');
  process.env.REIN_CLAUDE_JSON = path.join(process.env.REIN_HOME, 'claude.json');
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-mcp-')));
});
afterEach(async () => {
  await mcp?.closeAll();
  mcp = undefined;
});
const project = (servers: object) => writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({mcpServers: servers}));

describe('MCP config', () => {
  it('reads project, Rein and Claude Code servers; project ones need approval; ${VAR} expands', () => {
    process.env.REIN_TEST_TOKEN = 'secret123';
    project({repo: {command: 'node', args: ['x.js'], env: {TOKEN: '${REIN_TEST_TOKEN}', MODE: '${UNSET_VAR:-dev}'}}});
    writeFileSync(path.join(process.env.REIN_HOME!, 'mcp.json'), JSON.stringify({mcpServers: {mine: {type: 'http', url: 'https://example.com/mcp'}}}));
    writeFileSync(process.env.REIN_CLAUDE_JSON!, JSON.stringify({mcpServers: {fromclaude: {command: 'npx', args: ['srv']}}, projects: {[root]: {mcpServers: {local: {command: 'srv2'}}}}}));
    const s = loadServers(root);
    expect(s.map((x) => `${x.name}:${x.source}:${x.approved}`)).toEqual(['repo:project:false', 'mine:rein:true', 'fromclaude:claude:true', 'local:claude:true']);
    expect((s[0]!.config as any).env).toEqual({TOKEN: 'secret123', MODE: 'dev'});
    approveProjectServer(root, 'repo');
    expect(loadServers(root)[0]!.approved).toBe(true);
  });

  it('names tools like Claude Code (mcp__server__tool) and keeps them short', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
    expect(mcpToolName('my.server', 'a'.repeat(80)).length).toBe(50);
  });
});

describe('MCP tools', () => {
  it('connects to an approved stdio server and exposes its tools; unapproved ones wait', async () => {
    project({test: {command: 'node', args: [fixture]}, other: {command: 'node', args: [fixture]}});
    approveProjectServer(root, 'test');
    mcp = new McpManager(root);
    await mcp.start();
    expect(mcp.list().map((s) => `${s.name}:${s.status}:${s.tools}`).sort()).toEqual(['other:needs-approval:0', 'test:connected:4']);
    expect(mcp.tools().map((t) => t.name).sort()).toEqual(['mcp__test__add', 'mcp__test__ask_model', 'mcp__test__fail', 'mcp__test__remember']);
  });

  it('read-only tools run without approval; others go through approval and permission rules', async () => {
    const notes = path.join(root, 'notes.log');
    project({test: {command: 'node', args: [fixture], env: {NOTES_FILE: notes}}});
    approveProjectServer(root, 'test');
    mcp = new McpManager(root);
    await mcp.start();
    const asked: ApprovalRequest[] = [];
    const host = new ToolHost({root, mode: () => 'ask', approve: async (r) => (asked.push(r), 'once')});
    host.addSource(() => mcp!.tools());
    expect((await host.call('mcp__test__add', {a: 2, b: 3})).text).toBe('5');
    expect(asked).toHaveLength(0);
    expect((await host.call('mcp__rein__mcp__test__remember', {note: 'hello'})).text).toBe('saved: hello'); // via Claude's prefix too
    expect(asked).toHaveLength(1);
    expect(readFileSync(notes, 'utf8')).toBe('hello\n');
    expect((await host.call('mcp__test__fail', {})).ok).toBe(false);
    writeFileSync(path.join(root, '.rein-deny.json'), '');
    const denied = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', extraRules: () => ({allow: [], deny: ['mcp__test']})});
    denied.addSource(() => mcp!.tools());
    expect((await denied.call('mcp__test__add', {a: 1, b: 1})).text).toMatch(/blocked by a permission rule/);
    host.close();
    denied.close();
  });
});

describe('MCP sampling', () => {
  it("answers a server's createMessage with Rein's model, asking once per server", async () => {
    const {samplingHandler} = await import('../src/mcp/sampling.js');
    const {DEFAULT_CONFIG} = await import('../src/store/config.js');
    project({test: {command: 'node', args: [fixture]}});
    approveProjectServer(root, 'test');
    const prompts: {system: string; prompt: string; model: string}[] = [];
    const asks: string[] = [];
    let answer: 'once' | 'session' | 'deny' = 'session';
    let cfg = {...DEFAULT_CONFIG};
    mcp = new McpManager(root);
    mcp.sampling = samplingHandler({
      config: () => cfg,
      approve: async (server) => (asks.push(server), answer),
      complete: async (ref, _c, system, prompt) => (prompts.push({system, prompt, model: ref.model}), 'forty-two'),
    });
    // A catalog with one model, so the handler has something to pick.
    const {catalog} = await import('../src/router/catalog.js');
    const vi = (await import('vitest')).vi;
    const haiku = {provider: 'claude', id: 'haiku', label: 'Haiku', tier: 1, contextWindow: 1, accountIds: ['c1']} as any;
    vi.spyOn(catalog, 'available').mockReturnValue([haiku]);
    vi.spyOn(catalog, 'get').mockReturnValue(haiku);
    await mcp.start();
    const host = new ToolHost({root, mode: () => 'ask', approve: async () => 'once'});
    host.addSource(() => mcp!.tools());
    const call = () => host.call('mcp__test__ask_model', {question: 'What is 6 x 7?'});
    const first = await call();
    expect(first.text).toContain('said: forty-two');
    expect(prompts[0]!.prompt).toBe('What is 6 x 7?');
    expect(prompts[0]!.system).toMatch(/under about 50 tokens/);
    expect(first.text).toContain('model Haiku said');
    expect(prompts[0]!.model).toBe('haiku'); // the server hinted "haiku"
    await call();
    expect(asks).toEqual(['test']); // allowed for the session after the first yes
    answer = 'deny';
    mcp.sampling = samplingHandler({config: () => cfg, approve: async () => answer, complete: async () => 'x'});
    await mcp.closeAll();
    await mcp.start();
    expect((await call()).text).toMatch(/declined/); // the refusal reaches the server (its tool fails)
    cfg = {...cfg};
    vi.restoreAllMocks();
  });

  it('picks a hinted model, else by priority, and refuses when off', async () => {
    const {pickSamplingModel, samplingHandler, samplingPrompt} = await import('../src/mcp/sampling.js');
    const {DEFAULT_CONFIG} = await import('../src/store/config.js');
    const {catalog} = await import('../src/router/catalog.js');
    const models = [
      {provider: 'claude', id: 'haiku', label: 'Haiku', tier: 1, contextWindow: 1, accountIds: ['c1']},
      {provider: 'claude', id: 'opus', label: 'Opus', tier: 3, contextWindow: 1, accountIds: ['c1'], isDefault: true},
    ] as any[];
    const vi = (await import('vitest')).vi;
    vi.spyOn(catalog, 'available').mockReturnValue(models);
    vi.spyOn(catalog, 'cheapest').mockReturnValue(models[0]);
    vi.spyOn(catalog, 'defaultModel').mockReturnValue(models[1]);
    vi.spyOn(catalog, 'healthyAccounts').mockReturnValue([{id: 'c1'} as any]);
    const cfg = {...DEFAULT_CONFIG, chatModel: 'claude:opus'};
    const params = (prefs: object) => ({messages: [{role: 'user' as const, content: {type: 'text' as const, text: 'hi'}}], maxTokens: 10, modelPreferences: prefs});
    expect(pickSamplingModel(params({hints: [{name: 'haiku'}]}), cfg)?.model).toBe('haiku');
    expect(pickSamplingModel(params({intelligencePriority: 0.9}), cfg)?.model).toBe('opus');
    expect(pickSamplingModel(params({costPriority: 0.9, intelligencePriority: 0.1}), cfg)?.model).toBe('haiku');
    expect(samplingPrompt({...params({}), messages: [{role: 'user', content: {type: 'text', text: 'a'}}, {role: 'assistant', content: {type: 'text', text: 'b'}}, {role: 'user', content: {type: 'text', text: 'c'}}]}).prompt).toBe('User: a\n\nAssistant: b\n\nUser: c\n\nAssistant:');
    const off = samplingHandler({config: () => ({...cfg, mcpSampling: 'off'}), complete: async () => 'x'});
    await expect(off('s', params({}))).rejects.toThrow(/turned off/);
    const denied = samplingHandler({config: () => cfg, approve: async () => 'deny', complete: async () => 'x'});
    await expect(denied('s', params({}))).rejects.toThrow(/declined/);
    const allowed = samplingHandler({config: () => ({...cfg, mcpSampling: 'allow'}), complete: async () => 'ok'});
    expect((await allowed('s', params({}))).content).toEqual({type: 'text', text: 'ok'});
    vi.restoreAllMocks();
  });
});
