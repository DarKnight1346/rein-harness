import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {cloneArgs, cloneMissing, parseWorkspace} from '../src/workspace/index.js';
import {checkoutState, describeCheckout, sparseAdd, sparsePrompt} from '../src/workspace/sparse.js';

function upstream() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-up-')));
  const git = (...a: string[]) => execFileSync('git', a, {cwd: dir, stdio: 'ignore'});
  git('init', '-q', '-b', 'main');
  for (const f of ['README.md', 'services/pay/a.ts', 'services/search/b.ts', 'web/c.ts']) {
    mkdirSync(path.dirname(path.join(dir, f)), {recursive: true});
    writeFileSync(path.join(dir, f), f);
  }
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

describe('sparse and partial clones', () => {
  it('reads sparse and filter from the manifest, and builds the clone command', () => {
    const ws = parseWorkspace('/w/rein.workspace.yaml', 'repos:\n  - name: mono\n    url: git@x:mono.git\n    sparse: [services/pay/, web]\n    filter: blob:none\n  - name: bad\n    filter: everything\n');
    expect(ws.repos[0]).toMatchObject({sparse: ['services/pay', 'web'], filter: 'blob:none'});
    expect(cloneArgs(ws.repos[0]!)).toEqual(['clone', '--filter=blob:none', '--sparse', 'git@x:mono.git', path.resolve('/w/mono')]);
    expect(ws.errors).toEqual(['repos[1]: filter must be blob:none or tree:0, not everything']);
  });

  it('clones only the named folders, tells the agent the rest exists, and widens on request', async () => {
    const up = upstream();
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-sws-')));
    writeFileSync(path.join(root, 'rein.workspace.yaml'), `repos:\n  - name: mono\n    url: ${pathToFileURL(up).href}\n    sparse: [services/pay]\n`);
    const ws = parseWorkspace(path.join(root, 'rein.workspace.yaml'), `repos:\n  - name: mono\n    url: ${pathToFileURL(up).href}\n    sparse: [services/pay]\n`);
    expect(await cloneMissing(ws)).toEqual({cloned: ['mono'], failed: []});
    const mono = path.join(root, 'mono');
    expect([existsSync(path.join(mono, 'services/pay/a.ts')), existsSync(path.join(mono, 'web/c.ts')), existsSync(path.join(mono, 'README.md'))]).toEqual([true, false, true]);
    const state = await checkoutState(mono);
    expect(describeCheckout(state)).toBe('sparse: services/pay');
    expect(sparsePrompt(state)).toMatch(/only services\/pay\/ are on disk.*\n.*git show HEAD:<path>/);
    expect((await sparseAdd(mono, ['web'])).ok).toBe(true);
    expect(existsSync(path.join(mono, 'web/c.ts'))).toBe(true);
    expect(sparsePrompt(await checkoutState(up))).toBeUndefined();
  });
});
