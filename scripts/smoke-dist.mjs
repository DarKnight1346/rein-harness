#!/usr/bin/env node
/**
 * Runs the built dist/cli.js (the bundle), which the test suite never touches (it runs src/): the
 * version, one `rein -p` turn against a fake claude that also checks the MCP proxy file Rein hands
 * it exists, and the TUI in a terminal (node-pty, where it's installed) up to a ready prompt with no
 * error on screen. Run after `npm run build`; CI does, on every OS.
 */
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');
const run = (args, opts = {}) =>
  new Promise((resolve) => execFile(process.execPath, [cli, ...args], {timeout: 60_000, ...opts}, (err, stdout, stderr) => resolve({code: err ? (err.code ?? 1) : 0, stdout, stderr})));
const fail = (what, r) => {
  console.error(`smoke: ${what}\n--- stdout\n${r?.stdout ?? ''}\n--- stderr\n${r?.stderr ?? ''}`);
  process.exit(1);
};

if (!existsSync(cli) || !existsSync(path.join(root, 'dist', 'bundle', 'rein.js'))) fail('dist/cli.js or dist/bundle/rein.js is missing: run npm run build');

const version = await run(['--version']);
if (version.code !== 0 || !/^\d+\.\d+\.\d+/.test(version.stdout.trim())) fail('--version', version);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'rein-smoke-'));
const home = path.join(tmp, 'home');
const cwd = path.join(tmp, 'cwd');
for (const d of [home, cwd]) mkdirSync(d, {recursive: true});
writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({version: 1, importOffered: true, accounts: [{id: 'claude-1', provider: 'claude', home: null, imported: true}]}));
const fake = path.join(tmp, 'fake-claude.mjs');
writeFileSync(
  fake,
  `#!/usr/bin/env node
import {existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
const argv = process.argv.slice(2);
const mcp = argv[argv.indexOf('--mcp-config') + 1];
for (const s of Object.values(JSON.parse(mcp ?? '{}').mcpServers ?? {})) {
  const file = (s.args ?? []).find((a) => /mcpProxy\\.[jt]s$/.test(a));
  if (file && !existsSync(file)) { console.error('fake-claude: no MCP proxy at ' + file); process.exit(3); }
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({type: 'system', subtype: 'init', session_id: 'smoke'});
for await (const line of createInterface({input: process.stdin})) {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') out({type: 'control_response', response: {request_id: msg.request_id, response: {models: [{value: 'sonnet', displayName: 'Sonnet', description: 'Everyday tasks'}]}}});
  else if (msg.type === 'user') {
    out({type: 'stream_event', event: {type: 'content_block_start', content_block: {type: 'text'}}});
    out({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'smoke-ok'}}});
    out({type: 'result', subtype: 'success', result: 'smoke-ok', usage: {input_tokens: 10, output_tokens: 2}});
  }
}
`,
);
const turn = await run(['-p', 'hello'], {cwd, env: {...process.env, REIN_HOME: home, REIN_KEYCHAIN: '1', REIN_CLAUDE_BIN: fake}});
if (turn.code !== 0 || !turn.stdout.includes('smoke-ok')) fail('rein -p turn', turn);

// The TUI, in a terminal: it must reach the ready prompt without an error on screen.
const pty = await import('@lydell/node-pty').catch(() => undefined);
let tui = 'TUI skipped (node-pty is not installed)';
if (pty) {
  const screen = await new Promise((resolve) => {
    let out = '';
    // CI=0: on a CI runner Ink otherwise draws nothing until exit (it checks the CI variables).
    const p = pty.spawn(process.execPath, [cli], {cols: 120, rows: 40, cwd, env: {...process.env, CI: '0', REIN_HOME: home, REIN_KEYCHAIN: '1', REIN_CLAUDE_BIN: fake}});
    const done = () => {
      clearTimeout(timer);
      try {
        p.kill();
      } catch {}
      resolve(out);
    };
    const timer = setTimeout(done, 30_000);
    p.onData((d) => {
      out += d;
      const text = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      if (/\bERROR\b/.test(text) || text.includes('/ for commands')) setTimeout(done, 300);
    });
    p.onExit(done);
  });
  const text = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (/\bERROR\b/.test(text) || !text.includes('/ for commands')) fail('the TUI did not reach its prompt', {stdout: text.slice(-3000)});
  tui = 'the TUI reaches its prompt';
}

console.log(`smoke: dist/cli.js ${version.stdout.trim()} starts, runs a turn; ${tui}`);
process.exit(0);
