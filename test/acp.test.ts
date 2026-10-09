import * as acp from '@agentclientprotocol/sdk';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {buildAgent, promptText} from '../src/acp/server.js';

/** A stand-in for Rein's runtime: one turn that writes text, asks to edit a file, and reports the tool. */
function fakeRuntime() {
  const sent: string[] = [];
  const r: any = {
    planMode: false,
    config: {toolApproval: 'ask'},
    approver: undefined,
    agents: {closeAll() {}},
    stopHook: async () => undefined,
    engine: {
      transcript: {id: 'conv-1'},
      scratch: '/tmp',
      interrupted: false,
      interrupt() {
        this.interrupted = true;
      },
      reset() {
        this.transcript = {id: 'conv-2'};
      },
      async *send(text: string) {
        sent.push(text);
        yield {type: 'text', delta: 'Looking at it. '};
        const decision = await r.approver({tool: {name: 'edit', label: 'Edit'}, args: {path: 'src/a.ts'}, summary: 'src/a.ts', preview: '- old\n+ new'});
        yield {type: 'tool', activity: {phase: 'start', id: 7, label: 'Edit', summary: 'src/a.ts'}};
        yield {type: 'tool', activity: {phase: 'end', id: 7, label: 'Edit', summary: 'src/a.ts', ok: decision !== 'deny', result: decision === 'deny' ? 'refused' : 'edited'}};
        yield {type: 'text', delta: decision === 'deny' ? 'Skipped.' : 'Done.'};
        yield {type: 'done', interrupted: false};
      },
    },
  };
  return {r, sent};
}

describe('ACP server mode', () => {
  it('serves a session: streams text and tool calls, and asks the editor before a change', async () => {
    const {r, sent} = fakeRuntime();
    let loadedFor = '';
    const agent = buildAgent(async (cwd) => ((loadedFor = cwd), r));
    const updates: any[] = [];
    const asked: any[] = [];
    const client = acp
      .client({name: 'test-editor'})
      .onNotification('session/update', (ctx: any) => void updates.push(ctx.params.update))
      .onRequest('session/request_permission', (ctx: any) => (asked.push(ctx.params), {outcome: {outcome: 'selected', optionId: ctx.params.options[0].optionId}}));
    const conn = client.connect(agent);
    const init: any = await conn.agent.request('initialize', {protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}});
    expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(init.agentInfo.name).toBe('rein');
    const session: any = await conn.agent.request('session/new', {cwd: '/work/shop', mcpServers: []});
    expect(loadedFor).toBe(path.resolve('/work/shop')); // C:\\work\\shop on Windows
    expect(session.sessionId).toBe('conv-1');
    expect(session.modes.availableModes.map((m: any) => m.id)).toEqual(['ask', 'auto', 'bypass', 'plan']);
    const res: any = await conn.agent.request('session/prompt', {sessionId: 'conv-1', prompt: [{type: 'text', text: 'fix the bug'}, {type: 'resource', resource: {uri: 'file:///work/shop/src/a.ts', text: 'const a = 1;'}}]});
    expect(res.stopReason).toBe('end_turn');
    expect(sent[0]).toBe('fix the bug\n\n<file path="/work/shop/src/a.ts">\nconst a = 1;\n</file>');
    expect(asked[0]).toMatchObject({sessionId: 'conv-1', toolCall: {title: 'Edit: src/a.ts', kind: 'edit'}, options: [{optionId: 'once', kind: 'allow_once'}, {optionId: 'session', kind: 'allow_always'}, {optionId: 'deny', kind: 'reject_once'}]});
    expect(updates.map((u) => u.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
    expect(updates[1]).toMatchObject({toolCallId: 'tool-7', kind: 'edit', status: 'in_progress'});
    expect(updates[2]).toMatchObject({toolCallId: 'tool-7', status: 'completed'});

    await conn.agent.request('session/set_mode', {sessionId: 'conv-1', modeId: 'plan'});
    expect(r.planMode).toBe(true);
    // A plan goes to the editor; its choice comes back as Rein's plan decision.
    expect(await r.planPresenter({title: 'Split users', plan: 'Goal: split it.', milestones: ['split']})).toBe('implement');
    expect(asked.at(-1)).toMatchObject({toolCall: {title: 'Plan: Split users', kind: 'think'}, options: [{optionId: 'implement'}, {optionId: 'save'}, {optionId: 'revise'}]});
    await conn.agent.request('session/set_mode', {sessionId: 'conv-1', modeId: 'auto'});
    expect([r.planMode, r.config.toolApproval]).toEqual([false, 'auto']);
    await expect(conn.agent.request('session/new', {cwd: '/work/other', mcpServers: []})).rejects.toThrow(/this Rein serves .*work[\\/]shop/);
    expect(((await conn.agent.request('session/new', {cwd: '/work/shop', mcpServers: []})) as any).sessionId).toBe('conv-2');
    conn.close();
  });

  it('reads prompts: text, links and embedded files', () => {
    expect(promptText([{type: 'text', text: 'explain'}, {type: 'resource_link', uri: 'file:///p/a.ts', name: 'a.ts'}]).text).toBe('explain\n\n@/p/a.ts');
  });
});

describe('rein --acp over stdio', () => {
  it('answers initialize from a real process, with nothing else on stdout', async () => {
    const {spawn} = await import('node:child_process');
    const {mkdtempSync} = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const {Readable, Writable} = await import('node:stream');
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), '--acp'], {env: {...process.env, REIN_HOME: mkdtempSync(path.join(os.tmpdir(), 'rein-acp-'))}, stdio: ['pipe', 'pipe', 'inherit']});
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const init: any = await acp.client({name: 'test-editor'}).connectWith(stream, (ctx: any) => ctx.request('initialize', {protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}}));
    expect(init).toMatchObject({protocolVersion: acp.PROTOCOL_VERSION, agentInfo: {name: 'rein'}, agentCapabilities: {promptCapabilities: {image: true, embeddedContext: true}}});
    child.kill();
  }, 30_000);
});
