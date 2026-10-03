// Verify Rein's Codex flags + catalog leave no built-in tools: captures a RUST_LOG=trace request,
// then run `python3 codex-tools.py`. Usage (from spikes/): npx tsx verify-codex-tools.mts [model]
const MODEL = process.argv[2] ?? 'gpt-6-luna';
import {appServerArgs, writeReinCatalog} from '../src/providers/codex/catalog.ts';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
process.env.REIN_HOME ??= 'out/rein-home';
const acct = {id: 'codex-default', provider: 'codex' as const, home: null, imported: true};
const cat = await writeReinCatalog(acct);
const p = spawn('codex', ['app-server', ...appServerArgs(cat)], {env: {...process.env, RUST_LOG: 'trace'}, stdio: ['pipe', 'pipe', 'pipe']});
let err = ''; p.stderr.on('data', (d) => (err += d));
let out = ''; p.stdout.on('data', (d) => (out += d));
const send = (m: object) => p.stdin.write(JSON.stringify(m) + '\n');
send({id: 1, method: 'initialize', params: {clientInfo: {name: 'rein', title: 'Rein', version: '0'}}});
send({method: 'initialized'});
send({id: 2, method: 'thread/start', params: {model: MODEL, baseInstructions: 'Reply in one word.', personality: 'none', approvalPolicy: 'untrusted', sandbox: 'read-only', ephemeral: true}});
await new Promise((r) => setTimeout(r, 4000));
const tid = /"thread":\{"id":"([^"]+)"/.exec(out)?.[1];
send({id: 3, method: 'turn/start', params: {threadId: tid, input: [{type: 'text', text: 'hi'}], model: MODEL}});
await new Promise((r) => setTimeout(r, 12000));
p.kill();
writeFileSync('out/codex-appserver.jsonl', JSON.stringify({stderr: err}) + '\n');
console.log('catalog', cat, 'thread', tid, 'stderr bytes', err.length);
