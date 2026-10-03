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
    expect(mcp.list().map((s) => `${s.name}:${s.status}:${s.tools}`).sort()).toEqual(['other:needs-approval:0', 'test:connected:3']);
    expect(mcp.tools().map((t) => t.name).sort()).toEqual(['mcp__test__add', 'mcp__test__fail', 'mcp__test__remember']);
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
