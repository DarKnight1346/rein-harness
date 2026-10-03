#!/usr/bin/env node
// Minimal stand-in for `codex app-server`: answers a few JSON-RPC methods over stdio.
import readline from 'node:readline';
const cmd = process.argv[2];
if (cmd === '--version') { console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.160.0'}`); process.exit(0); }
if (cmd === 'update') { console.log('Updating Codex…'); console.log('Codex is up to date.'); process.exit(0); }
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
