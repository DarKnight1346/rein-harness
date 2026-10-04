import {execFileSync} from 'node:child_process';
import {checkCodex, incompatibleMessage, resetCodexCompat, SUPPORTED_CODEX} from '../providers/codex/compat.js';
import {readModelsCache} from '../providers/codex/catalog.js';
import {spawn} from '../util/platform.js';
import {existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {reinHome} from '../store/paths.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {adapters} from '../providers/index.js';
import {streamCommand} from '../providers/claude/adapter.js';
import type {ProviderId} from '../providers/types.js';
import {PROVIDERS} from '../providers/types.js';
import {loadAccounts} from '../store/accounts.js';
import {run} from '../util/proc.js';

/** Codex app-server is experimental; Rein was verified against this minor line. */
/** @deprecated kept for callers; see SUPPORTED_CODEX in providers/codex/compat.ts. */
export const TESTED_CODEX = SUPPORTED_CODEX;

/** Rein's install folder. REIN_INSTALL_ROOT overrides it (tests: self-update must never touch the real install). */
export const reinRoot = () => process.env.REIN_INSTALL_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let cachedVersion: string | undefined;

/**
 * Rein's version. From npm it's package.json's; a source checkout's package.json never changes
 * (CI picks the number when it publishes), so a checkout reports its newest release tag instead
 * (`git describe`: e.g. 0.1.15, or 0.1.15-3-gabc1234 with local commits on top).
 */
export function reinVersion(): string {
  if (cachedVersion) return cachedVersion;
  const root = reinRoot();
  if (existsSync(path.join(root, '.git'))) {
    try {
      const tag = execFileSync('git', ['-C', root, 'describe', '--tags', '--match', 'v[0-9]*'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000}).trim();
      if (tag) return (cachedVersion = tag.replace(/^v/, ''));
    } catch {}
  }
  try {
    return (cachedVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  } catch {
    return 'unknown';
  }
}

const minor = (v: string | undefined) => v?.split('.').slice(0, 2).join('.');

export const PACKAGE = 'rein-harness';

/** Latest published version from the npm registry (undefined if unreachable). */
export async function latestVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {signal: AbortSignal.timeout(10_000), headers: {accept: 'application/json'}});
    if (!res.ok) return undefined;
    const v = ((await res.json()) as {version?: unknown}).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Semver-ish compare of x.y.z (pre-release tags sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return {nums: core.split('.').map((n) => Number(n) || 0), pre};
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  return x.pre === undefined ? 1 : y.pre === undefined ? -1 : x.pre.localeCompare(y.pre);
}

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
  resetCodexCompat(); // a new codex gets a fresh check on the next start too
  const {accounts} = await loadAccounts();
  const account = accounts.find((a) => a.provider === 'codex');
  if (minor(version) !== SUPPORTED_CODEX) yield {text: `codex ${version} is newer/older than the verified ${SUPPORTED_CODEX}.x — checking the app-server protocol…`, level: 'warn'};
  const {report} = await checkCodex(version, account ? (await readModelsCache(account))?.models : undefined);
  for (const w of report.warnings) yield {text: `Codex: ${w}`, level: 'warn'};
  if (report.ok === false) {
    yield {text: incompatibleMessage(report), level: 'error'};
    return;
  }
  if (!account) {
    if (report.ok) yield {text: `Codex app-server protocol OK (everything Rein uses is there)`, level: 'ok'};
    return;
  }
  try {
    const models = await adapters.codex.listModels(account);
    yield {text: `Codex app-server protocol OK (everything Rein uses is there; ${models.length} models)`, level: 'ok'};
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
    // Installed from npm: ask the registry for the latest release, install only if it's newer.
    const latest = await latestVersion();
    if (!latest) {
      yield {text: `rein ${before}: couldn't get the latest version from npm (offline, or not published yet).`, level: 'warn'};
      return;
    }
    if (compareVersions(latest, before) <= 0) {
      yield {text: `rein ${before} (up to date — latest on npm is ${latest})`, level: 'ok'};
      return;
    }
    yield {text: `rein: npm install -g ${PACKAGE}@${latest}`, level: 'info'};
    let denied = false;
    for await (const line of streamCommand('npm', ['install', '-g', `${PACKAGE}@${latest}`], process.env)) {
      if (/EACCES|permission denied/i.test(line)) denied = true;
      if (line.startsWith('! ')) yield {text: `npm failed: ${line.slice(2)}`, level: 'error'};
      else if (line !== '✓ done' && line.trim()) yield {text: line, level: 'output'};
    }
    if (denied) yield {text: `npm can't write to the global folder. Run \`sudo npm install -g ${PACKAGE}@latest\`, or set a user-owned npm prefix (npm config set prefix ~/.npm-global).`, level: 'warn'};
  } else {
    yield {text: `Rein ${before}: no update source configured.`, level: 'warn'};
    return;
  }
  const after = reinVersion();
  yield after !== before ? {text: `rein ${before} → ${after} — restart rein to use it`, level: 'ok'} : {text: `rein ${after} (up to date)`, level: 'ok'};
}

/** How Rein is installed: from npm (can self-update), a source checkout, or something else. */
export function installKind(): 'npm' | 'checkout' | 'other' {
  const root = reinRoot();
  if (existsSync(path.join(root, '.git'))) return 'checkout';
  return root.includes(`${path.sep}node_modules${path.sep}`) ? 'npm' : 'other';
}

const LOCK_MS = 10 * 60_000;

/**
 * Launch-time auto-update (config `autoUpdate`, on by default): one registry request in the
 * background. An npm install with a newer release on npm installs it in a detached process (it
 * finishes even if Rein exits) and reports back; a source checkout only hears that one exists.
 * A lock file keeps several Rein windows from installing at once.
 */
export async function autoUpdate(notify: (text: string) => void): Promise<void> {
  if (process.env.REIN_NO_AUTOUPDATE) return;
  const kind = installKind();
  if (kind === 'other') return;
  const current = reinVersion();
  const latest = await latestVersion();
  // "0.1.15-3-gabc1234" (a checkout ahead of a tag) compares as its release 0.1.15.
  if (!latest || compareVersions(latest, current.replace(/-\d+-g[0-9a-f]+$/, '')) <= 0) return;
  if (kind === 'checkout') {
    notify(`Rein ${latest} is on npm (this checkout is ${current}) — git pull to update.`);
    return;
  }
  const lock = path.join(reinHome(), 'update.lock');
  try {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_MS) return; // another window is installing
  } catch {}
  mkdirSync(reinHome(), {recursive: true});
  writeFileSync(lock, String(process.pid));
  const child = spawn('npm', ['install', '-g', `${PACKAGE}@${latest}`], {detached: true, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += d));
  child.unref();
  child.on('error', () => rmSync(lock, {force: true}));
  child.on('close', (code) => {
    rmSync(lock, {force: true});
    if (code === 0) notify(`Rein updated ${current} → ${latest} — restart rein to use it.`);
    else if (/EACCES|permission denied/i.test(stderr)) notify(`Rein ${latest} is available, but npm can't write to the global folder. Run \`sudo npm install -g ${PACKAGE}@latest\` (or turn off auto-update in /settings).`);
    else notify(`Rein ${latest} is available; the automatic install failed. Run \`rein --update\`.`);
  });
}
