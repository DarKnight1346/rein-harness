// Spike: Codex dynamic tools via experimentalApi + item/tool/call.
import {AppServerClient} from '../src/providers/codex/appServer.ts';
import {appServerArgs, writeReinCatalog} from '../src/providers/codex/catalog.ts';
process.env.REIN_HOME ??= 'out/rein-home';
const acct = {id: 'codex-default', provider: 'codex' as const, home: null, imported: true};
const calls: any[] = [];
const client = await AppServerClient.start(acct, {
  args: appServerArgs(await writeReinCatalog(acct)),
  experimental: true,
  onServerRequest: async (method, params) => {
    if (method === 'item/tool/call') {
      calls.push(params);
      return {contentItems: [{type: 'inputText', text: String(params.arguments?.text ?? '').toUpperCase()}], success: true};
    }
    if (method.endsWith('requestApproval')) return {decision: 'decline'};
    throw {code: -32601, message: method};
  },
});
const th = await client.request('thread/start', {
  model: 'gpt-6-luna', baseInstructions: 'You are terse.', personality: 'none', approvalPolicy: 'untrusted', sandbox: 'read-only', ephemeral: true,
  dynamicTools: [{type: 'function', name: 'echo', description: 'Echo text back, uppercased.', inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}}],
});
let text = '';
const done = new Promise((res) => client.onNotification((n) => {
  if (n.method === 'item/agentMessage/delta') text += n.params.delta;
  if (n.method === 'turn/completed') res(n.params.turn.status);
}));
await client.request('turn/start', {threadId: th.thread.id, input: [{type: 'text', text: 'Call the echo tool with text "pelican" and reply with exactly what it returned.'}], model: 'gpt-6-luna'});
console.log('status', await done, '| calls', JSON.stringify(calls.map((c) => [c.namespace, c.tool, c.arguments])), '| reply', JSON.stringify(text));
client.close();
