import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {memoryTools, workspaceFacts} from '../src/tools/memory.js';
import {systemPrompt} from '../src/session/prompt.js';

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

function workspace() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-wsmem-')));
  mkdirSync(path.join(root, 'api', '.git'), {recursive: true});
  writeFileSync(path.join(root, 'rein.workspace.yaml'), 'repos: [api]\n');
  return {root, api: path.join(root, 'api')};
}

describe('workspace memory', () => {
  it('keeps workspace facts next to the manifest, shared by its repos, and forgets from both', async () => {
    const {root, api} = workspace();
    const [remember, forget] = memoryTools(() => api);
    await remember!.run({} as any, {fact: 'api releases before web: web pins the API client', scope: 'workspace'});
    await remember!.run({} as any, {fact: 'api tests need DATABASE_URL'});
    expect(readFileSync(path.join(root, '.rein', 'MEMORY.md'), 'utf8')).toMatch(/- api releases before web/);
    expect(readFileSync(path.join(api, '.rein', 'MEMORY.md'), 'utf8')).toMatch(/- api tests need DATABASE_URL/);
    expect(workspaceFacts(api)[0]).toMatch(/^api releases before web/);
    expect((await forget!.run({} as any, {match: 'releases before'})).text).toBe('Forgot 1 fact; 1 left.');
    expect(workspaceFacts(api)).toEqual([]);
  });

  it('shows workspace memory in the system prompt, and refuses workspace scope outside one', async () => {
    const {api} = workspace();
    process.chdir(api);
    await memoryTools(() => api)[0]!.run({} as any, {fact: 'all repos use pnpm', scope: 'workspace'});
    expect(await systemPrompt({tools: true})).toMatch(/# Workspace memory \(.*\.rein\/MEMORY\.md\)\nShared by every repo in this workspace.*\n- all repos use pnpm/);
    const lone = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-lone-')));
    await expect(memoryTools(() => lone)[0]!.run({} as any, {fact: 'x y z', scope: 'workspace'})).rejects.toThrow(/isn't in a workspace/);
  });
});
