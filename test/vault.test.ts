import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Vault, variants} from '../src/vault/vault.js';

const TOKEN = 'ghp_s3cretTOKENvalue+/=42';
let home: string;
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-vault-home-'));
  process.env.REIN_HOME = home; // the file store, never the real Keychain
});
afterAll(() => {
  delete process.env.REIN_HOME;
});

describe('vault masking', () => {
  it('masks a value and its common encodings, not short values', async () => {
    const v = new Vault();
    await v.load();
    await v.set('GH_TOKEN', TOKEN);
    await v.set('PIN', '1234');
    for (const form of variants(TOKEN)) expect(v.mask(`x ${form} y`)).toBe('x [secret:GH_TOKEN] y');
    expect(v.mask('pin 1234')).toBe('pin 1234');
    // `echo $X | base64`: the value plus a newline, any length.
    for (const len of [20, 21, 22]) {
      const value = 'k'.repeat(len - 4) + 'Zq9!';
      await v.set('ANY', value);
      const encoded = Buffer.from(value + '\n').toString('base64');
      expect(v.mask(encoded)).toMatch(/^\[secret:ANY\].{0,4}$/);
    }
    await v.remove('ANY');
    expect(v.mask(`"${JSON.stringify(TOKEN).slice(1, -1)}"`)).toBe('"[secret:GH_TOKEN]"');
  });
  it('persists (0600 file under REIN_HOME), removes, and validates names', async () => {
    const v = new Vault();
    await v.load();
    expect(v.names()).toEqual(['GH_TOKEN', 'PIN']);
    const file = path.join(home, 'secrets', 'vault.json');
    if (process.platform !== 'win32') expect(readFileSync(file).length).toBeGreaterThan(0);
    await expect(v.set('1BAD', 'x')).rejects.toThrow(/names are/);
    expect(await v.remove('PIN')).toBe(true);
    expect(await v.remove('PIN')).toBe(false);
  });
});

describe('vault in the tool host', () => {
  it('commands get the value; nothing the agent sees contains it', async () => {
    const {ToolHost} = await import('../src/tools/host.js');
    const {isSensitivePath} = await import('../src/tools/host.js');
    const {secretsDir} = await import('../src/store/secrets.js');
    const vault = new Vault();
    await vault.load();
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-vault-proj-'));
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', mask: (t) => vault.mask(t)});
    host.shells.vault = vault;
    const shown = await host.call('shell', {command: 'node -e "console.log(process.env.GH_TOKEN, process.env.GH_TOKEN === \'' + TOKEN + '\' ? \'same\' : \'different\')"'});
    expect(shown.text).toContain('[secret:GH_TOKEN] same');
    expect(shown.text).not.toContain(TOKEN);
    const b64 = await host.call('shell', {command: 'node -e "console.log(Buffer.from(process.env.GH_TOKEN).toString(\'base64\'))"'});
    expect(b64.text).toContain('[secret:GH_TOKEN]');
    // A file the command wrote, read back with the file tool.
    await host.call('shell', {command: 'node -e "require(\'fs\').writeFileSync(\'out.txt\', \'token=\' + process.env.GH_TOKEN)"'});
    expect(readFileSync(path.join(root, 'out.txt'), 'utf8')).toBe(`token=${TOKEN}`);
    const read = await host.call('read', {path: 'out.txt'});
    expect(read.text).toContain('token=[secret:GH_TOKEN]');
    expect(read.text).not.toContain(TOKEN);
    // Stored output (shell_logs reads it later) is masked too.
    for (const s of host.shells.list()) expect(s.lines.join('\n')).not.toContain(TOKEN);
    // Rein's own environment never has it (the claude/codex CLIs, MCP servers and hooks inherit that).
    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(isSensitivePath(path.join(secretsDir(), 'vault.json'))).toBe(true);
    host.close();
  });
  it('lists names, never values, in the system prompt', async () => {
    const {setVaultNames, systemPrompt} = await import('../src/session/prompt.js');
    setVaultNames(() => ['GH_TOKEN']);
    const p = await systemPrompt({tools: true});
    expect(p).toContain('$GH_TOKEN');
    expect(p).not.toContain(TOKEN);
    setVaultNames(() => []);
    writeFileSync(path.join(home, 'x'), '');
  });
});
