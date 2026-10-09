import {mkdtempSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {parse, parseAllDocuments} from 'yaml';
import {accountEnv} from '../src/providers/env.js';
import {loadAccounts, saveAccounts} from '../src/store/accounts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const saved = {...process.env};
afterEach(() => {
  process.env = {...saved};
});

describe('GitHub Action and GitLab component', () => {
  it('action.yml is a composite action with the documented inputs and outputs, actions pinned to SHAs', () => {
    const a = parse(readFileSync(path.join(root, 'action.yml'), 'utf8'));
    expect(a.runs.using).toBe('composite');
    expect(Object.keys(a.inputs)).toEqual(['prompt', 'anthropic-api-key', 'permission-mode', 'model', 'allowed-tools', 'version', 'working-directory', 'post-comment']);
    expect(a.runs.steps.at(-1).if).toMatch(/post-comment == 'true'/);
    expect(Object.keys(a.outputs)).toEqual(['result', 'is-error', 'cost-usd']);
    for (const s of a.runs.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('the GitLab component declares its inputs and a job', () => {
    const [spec, job] = parseAllDocuments(readFileSync(path.join(root, 'templates', 'rein.yml'), 'utf8')).map((d) => d.toJSON());
    expect(Object.keys(spec.spec.inputs)).toEqual(['prompt', 'stage', 'permission-mode', 'model', 'version', 'image']);
    expect(job.rein.script.join('\n')).toMatch(/rein -p/);
  });
});

describe('REIN_ENV_KEYS', () => {
  it('adds a one-run account that keeps ANTHROPIC_API_KEY, and never saves it', async () => {
    process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect((await loadAccounts()).accounts).toEqual([]);
    process.env.REIN_ENV_KEYS = '1';
    const file = await loadAccounts();
    expect(file.accounts).toMatchObject([{id: 'env-claude', provider: 'claude', api: 'console', envKey: true}]);
    expect(accountEnv(file.accounts[0]!).ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(accountEnv({id: 'claude-1', provider: 'claude', home: null, imported: true}).ANTHROPIC_API_KEY).toBeUndefined(); // other accounts: stripped
    await saveAccounts(file);
    expect(JSON.parse(readFileSync(path.join(process.env.REIN_HOME, 'accounts.json'), 'utf8')).accounts).toEqual([]);
  });
});
