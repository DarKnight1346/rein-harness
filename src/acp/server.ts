import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Readable, Writable} from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {ApprovalDecision, ApprovalRequest} from '../tools/host.js';
import {reinVersion} from '../commands/update.js';

/**
 * ACP server mode (`rein --acp`): Rein as an Agent Client Protocol agent over stdio, for Zed,
 * JetBrains and other ACP editors. The editor sends prompts; Rein streams its reply and tool calls
 * back as session updates, and asks the editor before changes, exactly where it would ask you in
 * the terminal. One project per process (the folder of the first session); stdout is the protocol.
 */
type Runtime = typeof import('../runtime.js').runtime;
type Client = {notify(method: string, params: unknown): Promise<void>; request(method: string, params: unknown): Promise<any>};

const KIND: Record<string, string> = {Read: 'read', List: 'read', Search: 'search', SemanticSearch: 'search', OrgSearch: 'search', Write: 'edit', Edit: 'edit', Delete: 'delete', Shell: 'execute', WebFetch: 'fetch', WebSearch: 'fetch'};
const kindOf = (label: string) => KIND[label] ?? 'other';
/** An error the editor shows as it is (a plain Error reaches it as "Internal error"). */
const invalid = (message: string) => new acp.RequestError(-32602, message);
const failed = (message: string) => new acp.RequestError(-32603, message);

export const MODES = [
  {id: 'ask', name: 'Ask', description: 'Confirm every file change'},
  {id: 'auto', name: 'Auto', description: 'The decision model approves changes that clearly match the request'},
  {id: 'bypass', name: 'Bypass', description: 'Allow every change without asking'},
  {id: 'plan', name: 'Plan', description: 'Explore read-only and present a plan; nothing changes'},
] as const;

/** The prompt as Rein's text: text blocks, and embedded files or links as @mentions with their content. */
export function promptText(blocks: any[], scratch?: string): {text: string; images: {path: string; mime: any}[]} {
  const parts: string[] = [];
  const images: {path: string; mime: any}[] = [];
  for (const b of blocks ?? []) {
    if (b?.type === 'text') parts.push(String(b.text ?? ''));
    else if (b?.type === 'resource_link') parts.push(`@${String(b.uri ?? '').replace(/^file:\/\//, '')}`);
    else if (b?.type === 'resource' && b.resource) {
      const uri = String(b.resource.uri ?? '').replace(/^file:\/\//, '');
      if (typeof b.resource.text === 'string') parts.push(`<file path="${uri}">\n${b.resource.text}\n</file>`);
      else parts.push(`@${uri}`);
    } else if (b?.type === 'image' && typeof b.data === 'string' && scratch) {
      const ext = String(b.mimeType ?? 'image/png').split('/')[1] ?? 'png';
      const f = path.join(scratch, `acp-image-${Date.now()}-${images.length}.${ext}`);
      mkdirSync(scratch, {recursive: true});
      writeFileSync(f, Buffer.from(b.data, 'base64'));
      images.push({path: f, mime: b.mimeType ?? 'image/png'});
    }
  }
  return {text: parts.join('\n\n').trim(), images};
}

/** Rein's approval as an ACP permission request; the editor's choice back as Rein's decision. */
export async function askEditor(client: Client, sessionId: string, req: ApprovalRequest, n: number): Promise<ApprovalDecision> {
  const res = await client.request(acp.CLIENT_METHODS.session_request_permission, {
    sessionId,
    toolCall: {toolCallId: `permission-${n}`, title: `${req.tool.label ?? req.tool.name}: ${req.summary}`, kind: kindOf(req.tool.label ?? ''), status: 'pending', rawInput: req.args, ...(req.preview ? {content: [{type: 'content', content: {type: 'text', text: req.preview.slice(0, 20_000)}}]} : {})},
    options: [
      {optionId: 'once', name: 'Allow', kind: 'allow_once'},
      {optionId: 'session', name: 'Allow for this session', kind: 'allow_always'},
      {optionId: 'deny', name: 'Reject', kind: 'reject_once'},
    ],
  }).catch(() => ({outcome: {outcome: 'cancelled'}}));
  const id = res?.outcome?.outcome === 'selected' ? res.outcome.optionId : 'deny';
  return id === 'once' || id === 'session' ? id : 'deny';
}

export function buildAgent(load: (cwd: string) => Promise<Runtime>) {
  let runtime: Runtime | undefined;
  let home: string | undefined;
  let client: Client | undefined;
  let approvals = 0;
  let cancelled = false;

  const mode = (r: Runtime) => (r.planMode ? 'plan' : r.config.toolApproval);
  return acp
    .agent({name: 'rein'})
    .onRequest('initialize', async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {loadSession: false, promptCapabilities: {image: true, embeddedContext: true}},
      agentInfo: {name: 'rein', title: 'Rein', version: reinVersion()},
      authMethods: [],
    }))
    .onRequest('authenticate', async () => ({}))
    .onRequest('session/new', async (ctx: any) => {
      const cwd = path.resolve(String(ctx.params?.cwd ?? process.cwd()));
      if (home && home !== cwd) throw invalid(`this Rein serves ${home}; start another one for ${cwd}`);
      if (!runtime) {
        home = cwd;
        runtime = await load(cwd);
      } else {
        runtime.agents.closeAll();
        runtime.engine.reset(); // a new ACP session: a new conversation in the same project
      }
      const r = runtime;
      r.approver = (req) => (client ? askEditor(client, r.engine.transcript.id, req, ++approvals) : Promise.resolve('deny'));
      // Plan mode: the plan goes to the editor to approve, like the plan window in the terminal.
      r.planPresenter = async (plan) => {
        if (!client) return undefined;
        const text = `# ${plan.title}\n\n${plan.plan.replace(/^#\s+.*\n+/, '')}\n\n## Milestones\n${plan.milestones.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
        const res = await client.request(acp.CLIENT_METHODS.session_request_permission, {
          sessionId: r.engine.transcript.id,
          toolCall: {toolCallId: `plan-${++approvals}`, title: `Plan: ${plan.title}`, kind: 'think', status: 'pending', content: [{type: 'content', content: {type: 'text', text}}]},
          options: [
            {optionId: 'implement', name: 'Implement it now', kind: 'allow_once'},
            {optionId: 'save', name: 'Save it for later', kind: 'allow_always'},
            {optionId: 'revise', name: 'Keep planning', kind: 'reject_once'},
          ],
        }).catch(() => undefined);
        const id = res?.outcome?.outcome === 'selected' ? res.outcome.optionId : 'revise';
        return id === 'implement' || id === 'save' ? id : 'revise';
      };
      return {sessionId: r.engine.transcript.id, modes: {currentModeId: mode(r), availableModes: MODES.map((m) => ({...m}))}};
    })
    .onRequest('session/set_mode', async (ctx: any) => {
      if (!runtime) throw invalid('no session: call session/new first');
      const id = String(ctx.params?.modeId ?? '');
      if (!MODES.some((m) => m.id === id)) throw invalid(`unknown mode ${id}`);
      runtime.planMode = id === 'plan';
      if (id !== 'plan') runtime.config = {...runtime.config, toolApproval: id as 'ask' | 'auto' | 'bypass'};
      return {};
    })
    .onRequest('session/prompt', async (ctx: any) => {
      const r = runtime;
      if (!r) throw invalid('no session: call session/new first');
      const sessionId = r.engine.transcript.id;
      client = ctx.client as Client;
      cancelled = false;
      const update = (u: Record<string, unknown>) => client!.notify(acp.CLIENT_METHODS.session_update, {sessionId, update: u}).catch(() => {});
      const {text, images} = promptText(ctx.params?.prompt ?? [], r.engine.scratch);
      if (!text && !images.length) return {stopReason: 'end_turn'};
      let error: string | undefined;
      const turn = async (message: string, imgs: typeof images = []) => {
        for await (const ev of r.engine.send(message, imgs)) {
          if (ev.type === 'text') await update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: ev.delta}});
          else if (ev.type === 'tool' && !ev.activity.origin) {
            const a = ev.activity;
            if (a.phase === 'start') await update({sessionUpdate: 'tool_call', toolCallId: `tool-${a.id}`, title: `${a.label}: ${a.summary}`, kind: kindOf(a.label), status: 'in_progress'});
            else await update({sessionUpdate: 'tool_call_update', toolCallId: `tool-${a.id}`, status: a.ok ? 'completed' : 'failed', content: [{type: 'content', content: {type: 'text', text: a.result.slice(0, 8000)}}]});
          } else if (ev.type === 'error') error = ev.message;
        }
      };
      await turn(text, images);
      // Stop hooks and the end-of-turn checks may send the agent back to work, as in the terminal.
      for (let depth = 0; !error && !cancelled && depth < 10; depth++) {
        const stop = await r.stopHook(depth > 0).catch(() => undefined);
        if (!stop) break;
        await turn(stop.kind === 'hook' ? `<stop_hook>\n${stop.reason}\n</stop_hook>\nContinue working.` : `<code_check>\n${stop.reason}\n</code_check>`);
      }
      if (cancelled) return {stopReason: 'cancelled'};
      if (error) throw failed(error);
      return {stopReason: 'end_turn'};
    })
    .onNotification('session/cancel', async () => {
      cancelled = true;
      runtime?.engine.interrupt();
    });
}

/** `rein --acp`: serve ACP on stdin/stdout until the editor closes the connection. */
export async function runAcp(): Promise<number> {
  // stdout carries the protocol: anything else printed goes to stderr.
  console.log = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`);
  const agent = buildAgent(async (cwd) => {
    process.chdir(cwd);
    // The runtime takes the project folder when it loads, so it's loaded only now.
    const {runtime} = await import('../runtime.js');
    await runtime.init({resume: false});
    await runtime.refreshCatalog();
    return runtime;
  });
  const conn = agent.connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
  await new Promise<void>((resolve) => conn.signal.addEventListener('abort', () => resolve()));
  return 0;
}
