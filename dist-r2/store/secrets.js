import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../util/proc.js';
import { writeFileSecure } from './json.js';
import { reinHome } from './paths.js';
const ACCOUNT = 'rein';
// A separate REIN_HOME keeps its secrets in files there, unless REIN_KEYCHAIN=1 (macOS) shares the Keychain
// with the normal install, e.g. so a scratch home can reach the same Jev key.
const useKeychain = () => process.platform === 'darwin' && (!process.env.REIN_HOME || process.env.REIN_KEYCHAIN === '1');
/** Windows: the file is encrypted with DPAPI (only this Windows user can decrypt it). */
const useDpapi = () => process.platform === 'win32' && !process.env.REIN_HOME;
export const secretsDir = () => path.join(reinHome(), 'secrets');
/** Run a DPAPI step in PowerShell; the secret travels via an env var, never the command line. */
async function dpapi(op, value) {
    const script = op === 'protect'
        ? "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:REIN_SECRET), $null, 'CurrentUser'))"
        : "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:REIN_SECRET), $null, 'CurrentUser'))";
    const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000, env: { ...process.env, REIN_SECRET: value } }).catch(() => undefined);
    return res?.code === 0 ? res.stdout.trim() || undefined : undefined;
}
/**
 * One stored secret: macOS Keychain (`service`), else a DPAPI-encrypted file on Windows, else
 * `secrets/<file>` (0600). With REIN_HOME set only the file is used, so test setups never touch
 * the real Keychain.
 */
export function secretStore(service, file) {
    const plain = () => path.join(secretsDir(), file);
    const dpapiFile = () => path.join(secretsDir(), `${file}.dpapi`);
    return {
        async get() {
            let value;
            if (useKeychain()) {
                const res = await run('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'], { timeoutMs: 10_000 }).catch(() => undefined);
                if (res?.code === 0)
                    value = res.stdout.trim() || undefined;
            }
            if (!value && useDpapi()) {
                const blob = (await readFile(dpapiFile(), 'utf8').catch(() => '')).trim();
                if (blob)
                    value = await dpapi('unprotect', blob);
            }
            if (!value)
                value = (await readFile(plain(), 'utf8').catch(() => '')).trim() || undefined;
            return value;
        },
        async set(value) {
            if (useKeychain()) {
                // -U updates an existing item. The value is briefly visible in this process's argv.
                const res = await run('security', ['add-generic-password', '-U', '-s', service, '-a', ACCOUNT, '-w', value], { timeoutMs: 10_000 }).catch(() => undefined);
                if (res?.code === 0) {
                    await rm(plain(), { force: true });
                    return 'keychain';
                }
            }
            if (useDpapi()) {
                const blob = await dpapi('protect', value);
                if (blob) {
                    await writeFileSecure(dpapiFile(), blob + '\n');
                    await rm(plain(), { force: true });
                    return 'keychain';
                }
            }
            await writeFileSecure(plain(), value + '\n');
            return 'file';
        },
        async delete() {
            if (useKeychain())
                await run('security', ['delete-generic-password', '-s', service, '-a', ACCOUNT], { timeoutMs: 10_000 }).catch(() => { });
            await rm(plain(), { force: true });
            await rm(dpapiFile(), { force: true });
        },
    };
}
const jev = secretStore('rein-jev-api-key', 'jev.key');
let cached;
/** Jev key: `TYPESAFE_API_KEY` env, else macOS Keychain, else ~/.rein/secrets/jev.key (0600). */
export async function getJevKey() {
    if (process.env.TYPESAFE_API_KEY)
        return process.env.TYPESAFE_API_KEY;
    if (cached !== undefined)
        return cached ?? undefined;
    const key = await jev.get();
    cached = key ?? null;
    return key;
}
export async function setJevKey(key) {
    cached = key;
    return jev.set(key);
}
export async function deleteJevKey() {
    cached = null;
    await jev.delete();
}
