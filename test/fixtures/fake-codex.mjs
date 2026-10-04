#!/usr/bin/env node
// Minimal stand-in for `codex app-server`: answers a few JSON-RPC methods over stdio.
import readline from 'node:readline';
const cmd = process.argv[2];
if (cmd === '--version') { console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.160.0'}`); process.exit(0); }
if (cmd === 'update') { console.log('Updating Codex…'); console.log('Codex is up to date.'); process.exit(0); }
if (cmd === 'features' && process.argv[3] === 'list') { console.log('apps  stable  true\nshell_tool  stable  true\nmulti_agent  experimental  false'); process.exit(0); }
if (cmd === 'app-server' && process.argv[3] === 'generate-json-schema') {
  // Just enough schema for Rein's compatibility check; FAKE_CODEX_SCHEMA=broken drops thread/fork.
  const fs = await import('node:fs');
  const out = process.argv[process.argv.indexOf('--out') + 1];
  fs.mkdirSync(out, {recursive: true});
  const union = (methods) => ({oneOf: methods.map((m) => ({properties: {method: {enum: [m]}}}))});
  const write = (f, v) => fs.writeFileSync(`${out}/${f}`, JSON.stringify(v));
  const broken = process.env.FAKE_CODEX_SCHEMA === 'broken';
  write('ClientRequest.json', union(['initialize', 'model/list', 'account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimits/read', 'thread/start', 'thread/resume', ...(broken ? [] : ['thread/fork']), 'turn/start', 'turn/interrupt']));
  write('ServerNotification.json', union(['item/agentMessage/delta', 'item/started', 'item/completed', 'turn/completed', 'thread/tokenUsage/updated', 'error', 'account/rateLimits/updated', 'account/login/completed']));
  write('ServerRequest.json', union(['item/tool/call', 'item/tool/requestUserInput']));
  const props = (...names) => ({properties: Object.fromEntries(names.map((n) => [n, {}]))});
  write('codex_app_server_protocol.v2.schemas.json', {definitions: {
    InitializeCapabilities: props('experimentalApi'),
    ThreadStartParams: props('model', 'baseInstructions', 'personality', 'approvalPolicy', 'sandbox', 'cwd', 'ephemeral', 'dynamicTools', 'config'),
    ThreadResumeParams: props('threadId', 'model', 'baseInstructions', 'personality', 'approvalPolicy', 'sandbox', 'cwd'),
    ThreadForkParams: props('threadId', 'ephemeral', 'excludeTurns', 'model', 'approvalPolicy', 'sandbox'),
    TurnStartParams: props('threadId', 'input', 'model', 'effort'),
    TurnInterruptParams: props('threadId', 'turnId'),
  }});
  write('DynamicToolCallParams.json', props('tool', 'arguments', 'callId'));
  write('DynamicToolCallResponse.json', props('contentItems', 'success'));
  process.exit(0);
}
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let pendingApproval;
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    // Reply to our server→client request.
    if (msg.id === 'srv-1') send({method: 'test/approvalAnswered', params: msg});
    return;
  }
  switch (msg.method) {
    case 'initialize': return send({id: msg.id, result: {userAgent: 'fake'}});
    case 'initialized': return;
    case 'account/read':
      return send({id: msg.id, result: process.env.CODEX_HOME?.includes('empty')
        ? {account: null, requiresOpenaiAuth: true}
        : {account: {type: 'chatgpt', email: 'me@example.com', planType: 'plus'}, requiresOpenaiAuth: true}});
    case 'account/login/start':
      send({id: msg.id, result: {type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.example/x'}});
      return setTimeout(() => send({method: 'account/login/completed', params: {loginId: 'L1', success: true, error: null}}), 20);
    case 'model/list':
      return send({id: msg.id, result: {data: [{id: 'gpt-x', displayName: 'GPT-X', description: 'Fast and affordable', isDefault: true, hidden: false}]}});
    case 'test/askApproval':
      send({id: msg.id, result: {}});
      return send({id: 'srv-1', method: 'item/commandExecution/requestApproval', params: {command: 'rm -rf /'}});
    default:
      return send({id: msg.id, error: {code: -32601, message: `no ${msg.method}`}});
  }
});
