import {readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {run} from '../util/proc.js';
import {writeFileSecure} from './json.js';
import {reinHome} from './paths.js';

const SERVICE = 'rein-jev-api-key';
const ACCOUNT = 'rein';
const fallbackFile = () => path.join(reinHome(), 'secrets', 'jev.key');
const useKeychain = () => process.platform === 'darwin' && !process.env.REIN_HOME;

let cached: string | null | undefined;

/** Jev key: `TYPESAFE_API_KEY` env, else macOS Keychain, else ~/.rein/secrets/jev.key (0600). */
export async function getJevKey(): Promise<string | undefined> {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  if (cached !== undefined) return cached ?? undefined;
  let key: string | undefined;
  if (useKeychain()) {
    const res = await run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {timeoutMs: 10_000}).catch(() => undefined);
    if (res?.code === 0) key = res.stdout.trim() || undefined;
  }
  if (!key) key = (await readFile(fallbackFile(), 'utf8').catch(() => '')).trim() || undefined;
  cached = key ?? null;
  return key;
}

export async function setJevKey(key: string): Promise<'keychain' | 'file'> {
  cached = key;
  if (useKeychain()) {
    // -U updates an existing item. The key is briefly visible in this process's argv.
    const res = await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', key], {timeoutMs: 10_000}).catch(() => undefined);
    if (res?.code === 0) {
      await rm(fallbackFile(), {force: true});
      return 'keychain';
    }
  }
  await writeFileSecure(fallbackFile(), key + '\n');
  return 'file';
}

export async function deleteJevKey(): Promise<void> {
  cached = null;
  if (useKeychain()) await run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], {timeoutMs: 10_000}).catch(() => {});
  await rm(fallbackFile(), {force: true});
}
