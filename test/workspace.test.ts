import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {agentsFiles} from '../src/session/prompt.js';
import {describeWorkspace, findWorkspace, parseWorkspace, workspaceDirs} from '../src/workspace/index.js';

/** A folder holding a manifest and three repos (api and web cloned, billing not). */
function workspace(manifest: string) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-ws-')));
  for (const r of ['api', 'web']) mkdirSync(path.join(root, r, '.git'), {recursive: true});
  writeFileSync(path.join(root, 'rein.workspace.yaml'), manifest);
  return root;
}

const MANIFEST = `name: shop
repos:
  - name: api
    path: api
    role: orders API (provider)
    branch: main
  - path: web
    role: storefront, calls the orders API
  - name: billing
    url: git@example.com:shop/billing.git
`;

describe('workspaces', () => {
  it('reads repos from rein.workspace.yaml, relative to the manifest, and notes which are cloned', () => {
    const root = workspace(MANIFEST);
    const ws = findWorkspace(path.join(root, 'web'))!;
    expect(ws.name).toBe('shop');
    expect(ws.repos.map((r) => [r.name, r.path, r.present])).toEqual([
      ['api', path.join(root, 'api'), true],
      ['web', path.join(root, 'web'), true],
      ['billing', path.join(root, 'billing'), false],
    ]);
    expect(ws.repos[0]).toMatchObject({role: 'orders API (provider)', branch: 'main'});
    expect(ws.errors).toEqual([]);
  });

  it('adds the other cloned repos as working directories, not the launch folder', () => {
    const root = workspace(MANIFEST);
    const here = path.join(root, 'web');
    expect(workspaceDirs(findWorkspace(here), here)).toEqual([path.join(root, 'api')]);
    expect(workspaceDirs(undefined)).toEqual([]);
  });

  it('describes the repos for the system prompt', () => {
    const root = workspace(MANIFEST);
    const text = describeWorkspace(findWorkspace(root)!, path.join(root, 'web'));
    expect(text).toMatch(/# Workspace "shop"/);
    expect(text).toMatch(/- web: .* \(the launch folder\) — storefront/);
    expect(text).toMatch(/- billing: .* — not cloned yet/);
  });

  it('accepts a map of repos, and reports bad entries instead of failing', () => {
    const file = path.join(os.tmpdir(), 'rein.workspace.yaml');
    expect(parseWorkspace(file, 'repos:\n  api: {path: ../api}\n  web: {}\n').repos.map((r) => r.name)).toEqual(['api', 'web']);
    const bad = parseWorkspace(file, 'repos:\n  - role: nothing else\n  - name: a\n  - name: a\n');
    expect(bad.repos.map((r) => r.name)).toEqual(['a']);
    expect(bad.errors).toEqual(['repos[0]: needs a path (or a name, used as the folder)', 'repos[2]: the name "a" is used twice']);
    expect(parseWorkspace(file, 'repos: [').errors[0]).toMatch(/^rein\.workspace\.yaml: /);
  });

  it("puts the workspace's AGENTS.md above each repo's own", async () => {
    const root = workspace(MANIFEST);
    writeFileSync(path.join(root, 'AGENTS.md'), 'Workspace rule: version every API.');
    writeFileSync(path.join(root, 'web', 'AGENTS.md'), 'Web rule: use pnpm.');
    const files = (await agentsFiles(path.join(root, 'web'))).map((f) => f.text);
    expect(files.indexOf('Workspace rule: version every API.')).toBeGreaterThanOrEqual(0);
    expect(files.indexOf('Workspace rule: version every API.')).toBeLessThan(files.indexOf('Web rule: use pnpm.'));
  });

  it('finds nothing outside a workspace', () => {
    expect(findWorkspace(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-nows-'))))).toBeUndefined();
  });
});
