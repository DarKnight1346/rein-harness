#!/usr/bin/env node
// Stand-in for `rein --ui-worker`: the web UI chat protocol over stdio (webui/worker.ts).
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const messages = [];
const snap = (busy = false) => ({session: 'sess-1', cwd: process.cwd(), title: messages.find((m) => m.role === 'user')?.text ?? 'New chat', messages, models: [{ref: 'claude:sonnet', label: 'Sonnet', provider: 'claude'}], chatModel: 'auto', mode: 'ask', busy});
let waiting;
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.t === 'init') send({t: 'ready', snapshot: snap()});
  else if (m.t === 'send') {
    messages.push({role: 'user', text: m.text, at: Date.now()});
    send({t: 'busy', busy: true});
    send({t: 'event', ev: {type: 'user', text: m.text}});
    if (m.text.includes('approve')) {
      waiting = m.text;
      return send({t: 'ask', id: 1, kind: 'approval', payload: {tool: 'Edit', summary: 'src/a.ts', preview: '+x', sensitive: false, outside: []}});
    }
    send({t: 'event', ev: {type: 'text', delta: `echo: ${m.text}`}});
    messages.push({role: 'assistant', text: `echo: ${m.text}`, at: Date.now()});
    send({t: 'busy', busy: false});
    send({t: 'snapshot', snapshot: snap()});
  } else if (m.t === 'answer' && waiting) {
    messages.push({role: 'assistant', text: `answered ${m.value}`, at: Date.now()});
    waiting = undefined;
    send({t: 'busy', busy: false});
    send({t: 'snapshot', snapshot: snap()});
  } else if (m.t === 'mode') send({t: 'snapshot', snapshot: {...snap(), mode: m.mode}});
  // A preview streamed with Rein Remote: where the test's stand-in listens (FAKE_REMOTE=port:token).
  else if (m.t === 'request' && m.op === 'remote-port') {
    const [port, token] = (process.env.FAKE_REMOTE ?? '').split(':');
    if (port && Number(m.args?.id) === 1) send({t: 'reply', id: m.id, value: {port: Number(port), token}});
    else send({t: 'reply', id: m.id, error: 'that preview has no Rein Remote stream'});
  }
});
