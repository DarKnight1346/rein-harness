import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `rein -p` in a scratch home with one (fake) account, so it gets past the account check. */
function rein(args: string[]): Promise<{code: number; stderr: string}> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({version: 1, importOffered: true, accounts: [{id: 'claude-1', provider: 'claude', home: null, imported: true}]}));
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rein-cwd-'));
  mkdirSync(path.join(cwd, 'sub'));
  return new Promise((resolve) =>
    execFile(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'src/cli.ts'), ...args], {cwd, env: {...process.env, REIN_HOME: home, REIN_KEYCHAIN: '1'}, timeout: 60_000}, (err, _out, stderr) =>
      resolve({code: (err as {code?: number} | null)?.code ?? 0, stderr}),
    ),
  );
}

describe('rein -p --add-dir', () => {
  it('takes extra working directories, and refuses one that does not exist', async () => {
    const r = await rein(['-p', 'hi', '--add-dir', 'no-such-dir']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no-such-dir is not a directory/);
  }, 60_000);
});
