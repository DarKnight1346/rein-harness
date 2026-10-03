// M0 spike: drive `codex app-server` over JSON-RPC stdio.
// Usage: node codex-appserver.mjs [model]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import readline from 'node:readline';

const MODEL = process.argv[2] ?? 'gpt-5.4-mini';

// Features that expose tools or extra prompt sections. Disabled so the model sees no built-in tools.
const DISABLE = [
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
  'multi_agent', 'plugins', 'remote_plugin', 'shell_tool', 'unified_exec', 'view_image',
  'goals', 'sleep_tool', 'tool_suggest', 'skill_search', 'collaboration_modes', 'hooks',
  'in_app_browser', 'workspace_dependencies', 'worktrees', 'code_mode_host',
];
const args = ['app-server', ...DISABLE.flatMap((f) => ['--disable', f]),
  '-c', 'web_search="disabled"', '-c', 'skills.enabled=false',
  ...(process.env.EXTRA ?? '').split(' ').filter(Boolean).flatMap((kv) => ['-c', kv])];

const env = { ...process.env };
for (const k of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[k];

const proc = spawn('codex', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
const log = [];
let nextId = 1;
const pending = new Map();
const listeners = [];

proc.stderr.on('data', (d) => log.push({ stderr: d.toString() }));
readline.createInterface({ input: proc.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { log.push({ raw: line }); return; }
  log.push(msg);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(msg.error) : resolve(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
});

const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n');
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

async function turn(threadId, text) {
  let out = '';
  const done = new Promise((resolve) => {
    listeners.push(function l(msg) {
      if (msg.method === 'item/agentMessage/delta') out += msg.params.delta ?? '';
      if (msg.method === 'item/started' && msg.params?.item?.type !== 'agentMessage'
          && msg.params?.item?.type !== 'userMessage' && msg.params?.item?.type !== 'reasoning') {
        console.log('  non-message item:', msg.params?.item?.type);
      }
      if (msg.method === 'turn/completed' || msg.method === 'error') {
        listeners.splice(listeners.indexOf(l), 1);
        resolve(msg);
      }
    });
  });
  const t0 = Date.now();
  await request('turn/start', { threadId, input: [{ type: 'text', text }], model: MODEL, effort: 'low' });
  const end = await done;
  console.log(`  [${Date.now() - t0}ms] ${end.method}${end.method === 'error' ? ' ' + JSON.stringify(end.params) : ''}`);
  console.log('  reply:', JSON.stringify(out));
}

try {
  await request('initialize', { clientInfo: { name: 'rein', title: 'Rein', version: '0.0.0' } });
  send({ method: 'initialized' });

  console.log('account/read:', JSON.stringify(await request('account/read', { refreshToken: true })));
  console.log('rateLimits:', JSON.stringify(await request('account/rateLimits/read', undefined)));
  const models = await request('model/list', {});
  console.log('models:', (models.data ?? models.items ?? []).map((m) => `${m.id ?? m.model}${m.isDefault ? '*' : ''}`).join(', '));

  const th = await request('thread/start', {
    model: MODEL,
    baseInstructions: 'You are a terse assistant. Reply in one short sentence.',
    personality: 'none',
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  const threadId = th.thread?.id ?? th.threadId;
  console.log('thread:', threadId);
  await turn(threadId, 'List the exact names of every tool/function you can call, or say "none".');
  await turn(threadId, 'What did I ask you first?');
} catch (e) {
  console.error('FAILED:', JSON.stringify(e));
} finally {
  mkdirSync('out', { recursive: true });
  writeFileSync('out/codex-appserver.jsonl', log.map((m) => JSON.stringify(m)).join('\n') + '\n');
  proc.kill();
}
