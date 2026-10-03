// Minimal MCP stdio server with one tool (spike).
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({jsonrpc: '2.0', id: msg.id, result: {protocolVersion: msg.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'rein', version: '0'}}});
  else if (msg.method === 'tools/list') send({jsonrpc: '2.0', id: msg.id, result: {tools: [{name: 'echo', description: 'Echo text back, uppercased.', inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}}]}});
  else if (msg.method === 'tools/call') send({jsonrpc: '2.0', id: msg.id, result: {content: [{type: 'text', text: String(msg.params.arguments.text).toUpperCase()}]}});
  else if (msg.id !== undefined) send({jsonrpc: '2.0', id: msg.id, result: {}});
});
