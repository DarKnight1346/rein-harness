import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {adapters} from '../providers/index.js';
import {streamCommand} from '../providers/claude/adapter.js';
import type {ProviderId} from '../providers/types.js';
import {PROVIDERS} from '../providers/types.js';
import {loadAccounts} from '../store/accounts.js';
import {run} from '../util/proc.js';

/** Codex app-server is experimental; Rein was verified against this minor line. */
export const TESTED_CODEX = '0.160';

export const reinRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function reinVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(reinRoot(), 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

const minor = (v: string | undefined) => v?.split('.').slice(0, 2).join('.');

export type UpdateLine = {text: string; level?: 'info' | 'ok' | 'warn' | 'error' | 'output'};

/**
 * `/update`: claude update → codex update → Codex protocol check → Rein self-update.
 * Live sessions are closed first (they restart lazily on the next message with resume/carry).
 */
export async function* runUpdate(closeSessions: () => void): AsyncGenerator<UpdateLine> {
  const providers: ProviderId[] = ['claude', 'codex'];
  const before: Record<string, string | undefined> = {};
  for (const p of providers) before[p] = await adapters[p].version();
  yield {text: `Current: claude ${before.claude ?? 'not found'} · codex ${before.codex ?? 'not found'} · rein ${reinVersion()}`};

  closeSessions();
  for (const p of providers) adapters[p].shutdown();

  for (const p of providers) {
    if (!before[p]) {
      yield {text: `${PROVIDERS[p].name} CLI not found — install it manually.`, level: 'warn'};
      continue;
    }
    yield {text: `${p} update`, level: 'info'};
    for await (const line of adapters[p].update()) {
      if (line.startsWith('! ')) yield {text: `${line.slice(2)} — run \`${p} update\` manually to see details`, level: 'error'};
      else if (line === '✓ done') continue;
      else if (line.trim()) yield {text: line, level: 'output'};
    }
    const after = await adapters[p].version();
    yield after && after !== before[p] ? {text: `${p} ${before[p]} → ${after}`, level: 'ok'} : {text: `${p} ${after ?? before[p]} (up to date)`, level: 'ok'};
  }

  yield* codexCompatCheck();
  yield* selfUpdate();
}

async function* codexCompatCheck(): AsyncGenerator<UpdateLine> {
  const version = await adapters.codex.version();
  if (!version) return;
  if (minor(version) !== TESTED_CODEX) {
    yield {text: `codex ${version} is newer/older than the tested ${TESTED_CODEX}.x — checking the app-server protocol…`, level: 'warn'};
  }
  const {accounts} = await loadAccounts();
  const account = accounts.find((a) => a.provider === 'codex');
  if (!account) return;
  try {
    const models = await adapters.codex.listModels(account);
    yield {text: `Codex app-server protocol OK (${models.length} models)`, level: 'ok'};
  } catch (err) {
    yield {text: `Codex app-server check failed: ${(err as Error).message}. Codex chats may break until Rein is updated.`, level: 'error'};
  } finally {
    adapters.codex.shutdown();
  }
}

async function* selfUpdate(): AsyncGenerator<UpdateLine> {
  const root = reinRoot();
  const before = reinVersion();
  if (existsSync(path.join(root, '.git'))) {
    const remote = (await run('git', ['-C', root, 'remote'], {timeoutMs: 10_000}).catch(() => undefined))?.stdout.trim();
    if (!remote) {
      yield {text: `Rein ${before}: git checkout without a remote — nothing to pull. (Add a remote, or run \`git pull && npm install && npm run build\` in ${root}.)`, level: 'warn'};
      return;
    }
    yield {text: 'rein: git pull --ff-only', level: 'info'};
    for (const [cmd, args] of [['git', ['-C', root, 'pull', '--ff-only']], ['npm', ['--prefix', root, 'install']], ['npm', ['--prefix', root, 'run', 'build']]] as const) {
      let failed = false;
      for await (const line of streamCommand(cmd, [...args], process.env)) {
        if (line.startsWith('! ')) {
          failed = true;
          yield {text: `${cmd} ${args.slice(2).join(' ')} failed: ${line.slice(2)}`, level: 'error'};
        } else if (line !== '✓ done' && line.trim()) yield {text: line, level: 'output'};
      }
      if (failed) return;
    }
  } else if (root.includes(`${path.sep}node_modules${path.sep}`)) {
    yield {text: 'rein: npm install -g rein-harness@latest', level: 'info'};
    for await (const line of streamCommand('npm', ['install', '-g', 'rein-harness@latest'], process.env)) {
      if (line.startsWith('! ')) yield {text: `npm failed: ${line.slice(2)}`, level: 'error'};
      else if (line !== '✓ done' && line.trim()) yield {text: line, level: 'output'};
    }
  } else {
    yield {text: `Rein ${before}: no update source configured.`, level: 'warn'};
    return;
  }
  const after = reinVersion();
  yield after !== before ? {text: `rein ${before} → ${after} — restart rein to use it`, level: 'ok'} : {text: `rein ${after} (up to date)`, level: 'ok'};
}
