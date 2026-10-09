import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {Runtime} from '../src/runtime.js';
import {setScopeDir, systemPrompt} from '../src/session/prompt.js';
import {ToolHost} from '../src/tools/host.js';

/** A small monorepo: packages/api and packages/web, each with a marker file. */
function monorepo() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-scope-')));
  mkdirSync(path.join(root, '.git'));
  for (const p of ['api', 'web']) {
    mkdirSync(path.join(root, 'packages', p), {recursive: true});
    writeFileSync(path.join(root, 'packages', p, `${p}.ts`), `export const where = '${p}';\n`);
  }
  writeFileSync(path.join(root, 'packages', 'api', 'AGENTS.md'), 'API rule: every handler validates input.');
  return root;
}

const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  setScopeDir(() => undefined);
});

describe('--scope', () => {
  it('makes list, search and shell start in the package unless given a path', async () => {
    const root = monorepo();
    const api = path.join(root, 'packages', 'api');
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', scope: () => api});
    expect((await host.call('search', {pattern: 'where'})).text).toMatch(/api\.ts/);
    expect((await host.call('search', {pattern: 'where'})).text).not.toMatch(/web\.ts/);
    expect((await host.call('list', {})).text).toMatch(/api\.ts/);
    expect((await host.call('search', {pattern: 'where', path: 'packages/web'})).text).toMatch(/web\.ts/); // still reachable
    expect((await host.call('shell', {command: 'ls'})).text).toMatch(/api\.ts/);
    host.close();
  });

  it("names the scope in the system prompt and loads the package's instructions", async () => {
    const root = monorepo();
    process.chdir(root);
    setScopeDir(() => path.join(root, 'packages', 'api'));
    const prompt = await systemPrompt({tools: true});
    expect(prompt).toMatch(/Scope: packages\/api\//);
    expect(prompt).toMatch(/API rule: every handler validates input/);
  });

  it('accepts only folders inside the project, and "off" clears it', () => {
    const root = monorepo();
    process.chdir(root);
    const r = Object.create(Runtime.prototype) as InstanceType<typeof Runtime>;
    expect(r.setScope('packages/api')).toBe(path.join(root, 'packages', 'api'));
    expect(() => r.setScope('..')).toThrow(/inside the project/);
    expect(() => r.setScope('packages/nope')).toThrow(/not a folder/);
    expect(r.setScope('off')).toBeUndefined();
    expect(r.setScope('.')).toBeUndefined(); // the whole project is no scope
  });
});
