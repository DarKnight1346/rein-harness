// A stand-in for the Claude Code IDE extension's MCP server (WebSocket, subprotocol "mcp",
// X-Claude-Code-Ide-Authorization). Used by test/ide.test.ts.
import {WebSocketServer} from 'ws';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';

class WsServerTransport {
  constructor(ws) {
    this.ws = ws;
    ws.on('message', (d) => this.onmessage?.(JSON.parse(String(d))));
    ws.on('close', () => this.onclose?.());
  }
  async start() {}
  async send(m) {
    this.ws.send(JSON.stringify(m));
  }
  async close() {
    this.ws.close();
  }
}

export async function startFakeIde({token, port = 0}) {
  const seen = {diffs: [], closed: 0, rejectedAuth: 0};
  const servers = [];
  const wss = new WebSocketServer({
    port,
    host: '127.0.0.1',
    handleProtocols: (protocols) => (protocols.has('mcp') ? 'mcp' : false),
    verifyClient: (info) => {
      const ok = info.req.headers['x-claude-code-ide-authorization'] === token;
      if (!ok) seen.rejectedAuth++;
      return ok;
    },
  });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', async (ws) => {
    const server = new McpServer({name: 'fake-ide', version: '1.0.0'});
    server.registerTool('openDiff', {inputSchema: {old_file_path: z.string(), new_file_path: z.string(), new_file_contents: z.string(), tab_name: z.string()}}, async (a) => {
      seen.diffs.push(a);
      // The "user" accepts unless the change contains REJECT; accepting with EDIT adds a line.
      if (a.new_file_contents.includes('REJECT')) return {content: [{type: 'text', text: 'DIFF_REJECTED'}, {type: 'text', text: a.tab_name}]};
      const contents = a.new_file_contents.includes('EDIT') ? a.new_file_contents + '\n// edited in the IDE' : a.new_file_contents;
      return {content: [{type: 'text', text: 'FILE_SAVED'}, {type: 'text', text: contents}]};
    });
    server.registerTool('getDiagnostics', {inputSchema: {uri: z.string().optional()}}, async (a) => ({content: [{type: 'text', text: JSON.stringify([{uri: a.uri ?? 'file:///all', diagnostics: [{message: "Cannot find name 'foo'", severity: 'Error', range: {start: {line: 2}}}]}])}]}));
    server.registerTool('closeAllDiffTabs', {inputSchema: {}}, async () => {
      seen.closed++;
      return {content: [{type: 'text', text: 'CLOSED'}]};
    });
    await server.connect(new WsServerTransport(ws));
    servers.push(server);
    ws.on('close', () => servers.splice(servers.indexOf(server), 1));
  });
  const notify = async (method, params) => {
    for (const s of [...servers]) await s.server.notification({method, params}).catch(() => {});
  };
  const close = () => {
    for (const c of wss.clients) c.terminate();
    return new Promise((r) => wss.close(r));
  };
  return {port: wss.address().port, seen, notify, close};
}
