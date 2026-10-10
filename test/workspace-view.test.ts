import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {listTool, readTool, searchTool, type ToolContext} from '../src/tools/fs.js';

function workspace(): ToolContext {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-view-')));
  for (const [repo, file, text] of [['web', 'src/cart.ts', 'fetch("/orders")\n'], ['api', 'src/orders.ts', 'route("/orders")\n']]) {
    mkdirSync(path.join(ws, repo!, 'src'), {recursive: true});
    writeFileSync(path.join(ws, repo!, file!), text!);
  }
  const web = path.join(ws, 'web');
  const api = path.join(ws, 'api');
  return {root: web, extraRoots: [api], workspaceRepos: [{name: 'web', path: web}, {name: 'api', path: api}]};
}

describe('synthetic monorepo view', () => {
  it('searches every repo with paths the other tools take as they are', async () => {
    const ctx = workspace();
    const res = await searchTool(ctx, {pattern: '/orders', workspace: true});
    expect(res.text).toBe('## web (.)\nsrc/cart.ts:1:fetch("/orders")\n\n## api (../api)\n../api/src/orders.ts:1:route("/orders")');
    expect((await readTool(ctx, {path: '../api/src/orders.ts'})).text).toMatch(/route\("\/orders"\)/);
    expect((await searchTool(ctx, {pattern: 'orders', files_only: true, workspace: true})).text).toMatch(/## api \(\.\.\/api\)\n\.\.\/api\/src\/orders\.ts/);
  });

  it('lists every repo as one tree, and needs a workspace', async () => {
    const ctx = workspace();
    expect((await listTool(ctx, {path: 'src', workspace: true})).text).toBe('## web (.)\nsrc/\ncart.ts  (17 B)\n\n## api (../api)\n../api/src/\norders.ts  (17 B)');
    await expect(searchTool({root: ctx.root}, {pattern: 'x', workspace: true})).rejects.toThrow(/needs a workspace/);
  });
});
