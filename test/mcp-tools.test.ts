import {mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {McpManager} from '../src/mcp/manager.js';
import {mcpTools} from '../src/mcp/tools.js';
import {ToolHost, type ApprovalMode, type ApprovalRequest} from '../src/tools/host.js';

const fixture = path.resolve('test/fixtures/mcp-server.mjs');
let root: string;
let mcp: McpManager;
let asked: ApprovalRequest[];
const setup = (mode: ApprovalMode, judgeAllows = true) => {
  const host: ToolHost = new ToolHost({root, mode: () => mode, approve: async (r) => (asked.push(r), 'once'), judge: async () => ({allow: judgeAllows, note: 'judge'})});
  host.register(...mcpTools({mcp, root: () => root, call: (n, a, o) => host.call(n, a, o)}));
  host.addSource(() => mcp.tools());
  return host;
};
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_CLAUDE_SETTINGS = path.join(process.env.REIN_HOME, 'none.json');
  process.env.REIN_CLAUDE_JSON = path.join(process.env.REIN_HOME, 'claude.json');
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-mcpt-')));
  mcp = new McpManager(root);
  asked = [];
});
afterEach(() => mcp.closeAll());

describe('agent-managed MCP servers', () => {
  it('adds a project server (approved, connected), uses it at once via mcp_call, lists and removes it', async () => {
    const host = setup('ask');
    const add = await host.call('mcp_add', {name: 'calc', command: 'node', args: [fixture]});
    expect(add.ok).toBe(true);
    expect(add.text).toContain('calc — connected');
    expect(add.text).toContain('tools: add, remember, fail');
    expect(asked[0]?.preview).toContain(`$ node ${fixture}`);
    const saved = JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    expect(saved.mcpServers.calc).toEqual({command: 'node', args: [fixture]});
    expect(JSON.parse(readFileSync(path.join(root, '.rein/settings.local.json'), 'utf8')).enabledMcpjsonServers).toEqual(['calc']);

    expect((await host.call('mcp_call', {server: 'calc', tool: 'add', args: {a: 20, b: 22}})).text).toBe('42');
    expect((await host.call('mcp_call', {server: 'calc', tool: 'nope'})).text).toMatch(/has no tool "nope"/);
    expect((await host.call('mcp_list', {})).text).toMatch(/calc — connected · stdio: node .*mcp-server\.mjs · from \.mcp\.json/);

    const rm = await host.call('mcp_remove', {name: 'calc'});
    expect(rm.text).toContain('Removed "calc"');
    expect(JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers).toEqual({});
    expect(mcp.tools()).toEqual([]);
    host.close();
  });

  it('adding always asks — even in auto mode when the judge would allow it', async () => {
    const host = setup('auto', true);
    await host.call('mcp_add', {name: 'calc', command: 'node', args: [fixture], scope: 'user'});
    expect(asked.map((r) => r.tool.name)).toEqual(['mcp_add']);
    expect(JSON.parse(readFileSync(path.join(process.env.REIN_HOME!, 'mcp.json'), 'utf8')).mcpServers.calc.command).toBe('node');
    host.close();
  });

  it('validates input and leaves Claude Code servers to the claude CLI', async () => {
    const host = setup('bypass');
    expect((await host.call('mcp_add', {name: 'bad name!', command: 'x'})).text).toMatch(/name must be/);
    expect((await host.call('mcp_add', {name: 'x'})).text).toMatch(/command \(stdio\) or url/);
    writeFileSync(process.env.REIN_CLAUDE_JSON!, JSON.stringify({mcpServers: {theirs: {command: 'node', args: [fixture]}}}));
    await mcp.start();
    expect((await host.call('mcp_remove', {name: 'theirs'})).text).toMatch(/claude mcp remove theirs/);
    expect((await host.call('mcp_remove', {name: 'ghost'})).text).toMatch(/no MCP server named "ghost"/);
    host.close();
  });
});
