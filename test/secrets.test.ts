import {mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {addedText, findSecrets, maskSecrets} from '../src/tools/secrets.js';
import {ToolHost} from '../src/tools/host.js';

// Built at runtime so this file itself doesn't look like it holds credentials.
const AWS = ['AKIA', 'Q3EGRTZ7YV4XN2KD'].join('');
const GH = ['ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const RANDOM = ['q8Zr', '2Lx9', 'Vw4N', 'tKe7', 'Hp3M'].join('');

describe('secret scanning', () => {
  it('finds credentials by their shapes and random values assigned to secret-looking names', () => {
    expect(findSecrets(`const key = "${AWS}";`).map((h) => h.kind)).toEqual(['AWS access key']);
    expect(findSecrets(`token: ${GH}`).map((h) => h.kind)).toEqual(['GitHub token']);
    expect(findSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----`).map((h) => h.kind)).toEqual(['private key']);
    expect(findSecrets(`const apiSecret = "${RANDOM}";`).map((h) => h.kind)).toEqual(['secret in apiSecret']);
  });

  it('leaves placeholders, env lookups and ordinary code alone', () => {
    for (const s of ['password = "your-password-here-please"', 'apiKey: "xxxxxxxxxxxxxxxxxxxx"', 'token = "${process.env.TOKEN_VALUE_X}"', 'const passwordField = "password-input-field"', 'secret = os.environ["SECRET_KEY"]'])
      expect(findSecrets(s), s).toEqual([]);
  });

  it("counts only what a change adds, so moving a line isn't new", () => {
    expect(addedText('edit', {old_string: `a\nkey = "${AWS}"`, new_string: `key = "${AWS}"\nb`})).toBe('b');
    expect(addedText('write', {content: 'x'})).toBe('x');
  });

  it('masks them for saved conversations, keeping a recognizable prefix', () => {
    expect(maskSecrets(`use ${AWS} now`)).toBe('use AKIA…[secret: AWS access key] now');
  });

  it('warns the agent or blocks the edit, as configured', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-sec-')));
    writeFileSync(path.join(root, 'a.ts'), 'export {};\n');
    let mode: 'off' | 'warn' | 'block' = 'block';
    const h = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', secretScan: () => mode});
    const blocked = await h.call('write', {path: 'a.ts', content: `export const k = "${AWS}";\n`});
    expect(blocked).toMatchObject({ok: false, text: expect.stringMatching(/^blocked: .*AWS access key.*a\.ts/)});
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('export {};\n');
    mode = 'warn';
    await h.call('read', {path: 'a.ts'});
    const warned = await h.call('write', {path: 'a.ts', content: `export const k = "${AWS}";\n`});
    expect(warned.ok).toBe(true);
    expect(warned.text).toMatch(/<secret_scan>This change adds what looks like a credential \(AWS access key\)/);
    h.close();
  });
});
