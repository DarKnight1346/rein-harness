#!/usr/bin/env node
// MCP stdio server launched by `claude` for Rein's tools. Deliberately dependency-free and thin:
// it forwards tools/list and tools/call over REIN_TOOL_SOCKET to the Rein process, which runs the
// tools (with approvals and transcript activity).
import net from 'node:net';
import readline from 'node:readline';
const sock = process.env.REIN_TOOL_SOCKET;
if (!sock) {
    process.stderr.write('REIN_TOOL_SOCKET not set\n');
    process.exit(1);
}
const conn = net.createConnection(sock);
const pending = new Map();
let nextId = 1;
let buf = '';
conn.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const reply = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        pending.get(reply.id)?.(reply);
        pending.delete(reply.id);
    }
});
conn.on('error', (err) => {
    process.stderr.write(`rein tool socket: ${err.message}\n`);
    process.exit(1);
});
const host = (msg) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    conn.write(JSON.stringify({ ...msg, id }) + '\n');
});
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let msg;
    try {
        msg = JSON.parse(line);
    }
    catch {
        return;
    }
    if (msg.id === undefined)
        return; // notifications (initialized, cancelled)
    switch (msg.method) {
        case 'initialize':
            return send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rein', version: '0.1.0' } } });
        case 'tools/list': {
            const reply = await host({ method: 'list' });
            return send({ id: msg.id, result: { tools: reply.tools } });
        }
        case 'tools/call': {
            const reply = await host({ method: 'call', name: msg.params?.name, args: msg.params?.arguments ?? {} });
            const images = (reply.images ?? []).map((i) => ({ type: 'image', data: i.base64, mimeType: i.mime }));
            return send({ id: msg.id, result: { content: [{ type: 'text', text: reply.text ?? reply.error ?? '' }, ...images], isError: !reply.ok } });
        }
        case 'ping':
            return send({ id: msg.id, result: {} });
        default:
            return send({ id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
    }
});
process.stdin.on('end', () => process.exit(0));
