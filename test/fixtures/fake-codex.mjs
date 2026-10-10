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
    // The ChatGPT Pets app through codex_apps (FAKE_PET: the active pet; default none).
    case 'thread/start':
      return send({id: msg.id, result: {thread: {id: 'thread-1'}}});
    case 'mcpServerStatus/list':
      return send({id: msg.id, result: {data: [{name: 'codex_apps', tools: Object.fromEntries(['list_pets', 'select_pet', 'get_pet_download_link', 'delete_pet'].map((t) => [`pets.${t}`, {name: `pets.${t}`, description: t, inputSchema: {type: 'object', properties: {}}, annotations: {readOnlyHint: t === 'list_pets' || t === 'get_pet_download_link', destructiveHint: t === 'delete_pet'}}]))}]}});
    case 'mcpServer/tool/call': {
      const {tool, arguments: args = {}} = msg.params;
      const active = globalThis.fakePet ?? process.env.FAKE_PET ?? 'default';
      if (tool === 'pets.list_pets') return send({id: msg.id, result: {content: [{type: 'text', text: 'Action completed.'}], structuredContent: {pets: [{id: 'codex', name: 'Codex', description: 'The original Codex companion.', is_custom: false, is_active: active === 'codex'}], cursor: null, active_pet_id: active}, isError: false}});
      if (tool === 'pets.select_pet') { globalThis.fakePet = args.pet_id; return send({id: msg.id, result: {content: [], structuredContent: {active_pet_id: args.pet_id}, isError: false}}); }
      if (tool === 'pets.get_pet_download_link') return send({id: msg.id, result: {content: [], structuredContent: {pet_id: args.pet_id, spritesheet_url: `https://cdn.example/${args.pet_id}.png`}, isError: false}});
      return send({id: msg.id, result: {content: [{type: 'text', text: `no ${tool}`}], isError: true}});
    }
    case 'test/askApproval':
      send({id: msg.id, result: {}});
      return send({id: 'srv-1', method: 'item/commandExecution/requestApproval', params: {command: 'rm -rf /'}});
    default:
      return send({id: msg.id, error: {code: -32601, message: `no ${msg.method}`}});
  }
});
