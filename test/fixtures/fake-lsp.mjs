#!/usr/bin/env node
// A tiny language server for tests: real LSP framing over stdio. A line containing BAD is an
// error, OLD a warning, and `// uses x.ts` an error while x.ts contains BROKEN. Like real servers,
// it publishes on open and, after a change, only for files whose problems changed.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

let buf = Buffer.alloc(0);
const docs = new Map(); // uri -> text
const last = new Map(); // uri -> last published JSON
const send = (m) => {
  const body = Buffer.from(JSON.stringify(m));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const textOf = (file) => {
  for (const [uri, text] of docs) if (fileURLToPath(uri) === file) return text;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const diagnose = (uri, text) =>
  text.split('\n').flatMap((l, i) => {
    const out = [];
    if (l.includes('BAD')) out.push({severity: 1, code: 'X1', source: 'fake', message: `bad value on purpose: ${l.trim()}`, range: {start: {line: i, character: l.indexOf('BAD')}, end: {line: i, character: l.indexOf('BAD') + 3}}});
    if (l.includes('OLD')) out.push({severity: 2, source: 'fake', message: 'an old warning', range: {start: {line: i, character: 0}, end: {line: i, character: 1}}});
    const uses = /\/\/ uses (\S+)/.exec(l);
    if (uses && textOf(path.join(path.dirname(fileURLToPath(uri)), uses[1])).includes('BROKEN')) out.push({severity: 1, code: 'X2', source: 'fake', message: `${uses[1]} is broken`, range: {start: {line: i, character: 0}, end: {line: i, character: 1}}});
    return out;
  });
const publish = (uri, always) => {
  const diagnostics = diagnose(uri, docs.get(uri));
  const json = JSON.stringify(diagnostics);
  if (!always && last.get(uri) === json) return;
  last.set(uri, json);
  send({jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {uri, diagnostics}});
};
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString());
    buf = buf.subarray(h + 4 + len);
    if (msg.method === 'initialize') send({jsonrpc: '2.0', id: msg.id, result: {capabilities: {textDocumentSync: 1}}});
    else if (msg.method === 'textDocument/didOpen') {
      docs.set(msg.params.textDocument.uri, msg.params.textDocument.text);
      setTimeout(() => publish(msg.params.textDocument.uri, true), 20);
    } else if (msg.method === 'textDocument/didChange') {
      docs.set(msg.params.textDocument.uri, msg.params.contentChanges[0].text);
      setTimeout(() => {
        for (const uri of docs.keys()) publish(uri, false);
      }, 20);
    } else if (msg.method === 'textDocument/didClose') docs.delete(msg.params.textDocument.uri);
    else if (msg.method === 'shutdown') send({jsonrpc: '2.0', id: msg.id, result: null});
    else if (msg.method === 'exit') process.exit(0);
  }
});
