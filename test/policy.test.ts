import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {checkPolicy, loadPolicy, modelBlocked, parsePolicy} from '../src/policy.js';
import {ToolHost, type ApprovalRequest} from '../src/tools/host.js';

const POLICY = `rules:
  - deny: shell
    command: "git push --force"
    reason: No force pushes
  - ask: [edit, write, delete]
    paths: ["migrations/**"]
    reason: Migrations need a human look
models:
  allow: ["claude:*"]
`;

function project() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-policy-')));
  mkdirSync(path.join(root, '.rein'));
  mkdirSync(path.join(root, 'migrations'));
  writeFileSync(path.join(root, '.rein', 'policy.yaml'), POLICY);
  writeFileSync(path.join(root, 'migrations', '001.sql'), 'create table a (id int);\n');
  writeFileSync(path.join(root, 'app.ts'), 'export {};\n');
  return root;
}

describe('policy as code', () => {
  it('matches rules by tool, path and command; deny wins over ask', () => {
    const p = parsePolicy(POLICY, '.rein/policy.yaml');
    expect(checkPolicy(p, 'shell', {command: 'git push --force origin main'}, [])?.reason).toBe('No force pushes');
    expect(checkPolicy(p, 'shell', {command: 'git push origin main'}, [])).toBeUndefined();
    expect(checkPolicy(p, 'edit', {}, ['migrations/001.sql'])).toMatchObject({effect: 'ask'});
    expect(checkPolicy(p, 'edit', {}, ['src/app.ts'])).toBeUndefined();
    expect(checkPolicy(parsePolicy('rules:\n  - ask: "*"\n    reason: a\n  - deny: "*"\n    reason: b\n', 'x'), 'read', {}, [])?.effect).toBe('deny');
    expect(parsePolicy('rules:\n  - reason: nothing\n', 'x').errors[0]).toMatch(/needs deny: or ask:/);
  });

  it('limits which models may work here', () => {
    const p = parsePolicy(POLICY, 'x');
    expect(modelBlocked(p, {provider: 'claude', model: 'opus'})).toBeUndefined();
    expect(modelBlocked(p, {provider: 'codex', model: 'gpt-6.1-sol'})).toMatch(/isn't in the policy's models\.allow/);
    expect(modelBlocked(parsePolicy('models:\n  deny: ["claude:fable"]\n', 'x'), {provider: 'claude', model: 'fable'})).toMatch(/denied by the policy/);
  });

  it('refuses denied calls and asks for the rest even in bypass', async () => {
    const root = project();
    const asked: ApprovalRequest[] = [];
    const h = new ToolHost({root, mode: () => 'bypass', approve: async (r) => (asked.push(r), 'deny'), policy: () => loadPolicy(root, path.join(root, 'no-user-dir')), steerShell: () => false});
    expect(await h.call('shell', {command: 'git push --force'})).toMatchObject({ok: false, text: expect.stringMatching(/^blocked by the project's policy \(\.rein\/policy\.yaml\): No force pushes/)});
    await h.call('read', {path: 'migrations/001.sql'});
    const r = await h.call('edit', {path: 'migrations/001.sql', old_string: 'int', new_string: 'bigint'});
    expect(r).toMatchObject({ok: false, text: expect.stringMatching(/declined this \(policy/)});
    expect(asked.at(-1)?.reason).toBe('Policy (.rein/policy.yaml): Migrations need a human look.');
    await h.call('read', {path: 'app.ts'});
    expect((await h.call('edit', {path: 'app.ts', old_string: 'export {};', new_string: 'export const a = 1;'})).ok).toBe(true); // not covered
    h.close();
  });
});
