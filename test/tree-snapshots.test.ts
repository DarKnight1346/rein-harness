import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {TreeSnapshots} from '../src/session/snapshots.js';

let root: string;
let snaps: TreeSnapshots;
const f = (p: string) => path.join(root, p);
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-tree-')));
  mkdirSync(f('src'));
  writeFileSync(f('src/a.ts'), 'a1\n');
  writeFileSync(f('src/b.ts'), 'b1\n');
  writeFileSync(f('.gitignore'), 'build/\n');
  mkdirSync(f('build'));
  writeFileSync(f('build/out.js'), 'compiled\n');
  snaps = new TreeSnapshots(root, () => 's1');
});

describe('whole-tree snapshots', () => {
  it("in a git repo, start from the project's own index and objects (no re-hashing), and still restore", async () => {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: root});
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    writeFileSync(f('src/untracked.ts'), 'u1\n'); // not committed: still part of the snapshot
    await snaps.snapshot(1);
    const store = path.join(process.env.REIN_HOME!, 'checkpoints', 's1', 'tree.git');
    expect(readFileSync(path.join(store, 'objects', 'info', 'alternates'), 'utf8').trim()).toBe(path.join(root, '.git', 'objects'));
    writeFileSync(f('src/a.ts'), 'a2\n');
    writeFileSync(f('src/untracked.ts'), 'u2\n');
    execFileSync('rm', [f('src/b.ts')]);
    const r = await snaps.restore(1);
    expect(r.restored.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/untracked.ts']);
    expect(readFileSync(f('src/a.ts'), 'utf8')).toBe('a1\n');
    expect(readFileSync(f('src/b.ts'), 'utf8')).toBe('b1\n');
    expect(readFileSync(f('src/untracked.ts'), 'utf8')).toBe('u1\n');
  });

  it('undoes shell-style changes: edits, deletions and new files — ignored files untouched', async () => {
    await snaps.snapshot(1);
    // What a `sed -i`, `rm` and a generator would do — none of it through Rein's file tools.
    writeFileSync(f('src/a.ts'), 'a2\n');
    execFileSync('rm', [f('src/b.ts')]);
    writeFileSync(f('src/new.ts'), 'generated\n');
    writeFileSync(f('build/out.js'), 'recompiled\n');
    expect((await snaps.changedSince(1)).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts']);
    const r = await snaps.restore(1);
    expect(readFileSync(f('src/a.ts'), 'utf8')).toBe('a1\n');
    expect(readFileSync(f('src/b.ts'), 'utf8')).toBe('b1\n');
    expect(existsSync(f('src/new.ts'))).toBe(false);
    expect(readFileSync(f('build/out.js'), 'utf8')).toBe('recompiled\n'); // .gitignore'd: left alone
    expect(r.removed).toEqual(['src/new.ts']);
  });

  it('restores bytes exactly, whatever the line endings or .gitattributes say', async () => {
    writeFileSync(f('.gitattributes'), '* text=auto eol=crlf\n');
    writeFileSync(f('src/mixed.txt'), 'unix\nwindows\r\nend');
    await snaps.snapshot(1);
    writeFileSync(f('src/mixed.txt'), 'changed');
    await snaps.restore(1);
    expect(readFileSync(f('src/mixed.txt'), 'latin1')).toBe('unix\nwindows\r\nend');
  });

  it("never touches the project's own git repo", async () => {
    execFileSync('git', ['init', '-q'], {cwd: root});
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first'], {cwd: root});
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'});
    await snaps.snapshot(1);
    writeFileSync(f('src/a.ts'), 'changed\n');
    await snaps.restore(1);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'})).toBe(head);
    expect(execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'})).not.toContain('src/a.ts');
  });
});

describe('cross-repo rewind', () => {
  it('snapshots every workspace repo at once and rewinds them all to the same message', async () => {
    const {WorkspaceSnapshots} = await import('../src/session/snapshots.js');
    const api = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-api-')));
    writeFileSync(path.join(api, 'orders.ts'), 'v1\n');
    let repos = [api];
    const ws = new WorkspaceSnapshots(root, () => 'ws1', () => repos);
    await ws.snapshot(1);
    writeFileSync(f('src/a.ts'), 'a2\n');
    writeFileSync(path.join(api, 'orders.ts'), 'v2\n');
    writeFileSync(path.join(api, 'new.ts'), 'added\n');
    const relApi = path.relative(root, api).split(path.sep).join('/');
    expect((await ws.changedSince(1)).sort()).toEqual(['src/a.ts', `${relApi}/new.ts`, `${relApi}/orders.ts`].sort());
    const r = await ws.restore(1);
    expect(r.failed).toEqual([]);
    expect(r.removed).toEqual([`${relApi}/new.ts`]);
    expect([readFileSync(f('src/a.ts'), 'utf8'), readFileSync(path.join(api, 'orders.ts'), 'utf8'), existsSync(path.join(api, 'new.ts'))]).toEqual(['a1\n', 'v1\n', false]);
    // A repo that joined later has no snapshot for the older message: the rest still rewinds.
    const web = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-web-')));
    writeFileSync(path.join(web, 'x.ts'), 'w\n');
    await ws.snapshot(2);
    repos = [api, web];
    writeFileSync(f('src/a.ts'), 'a3\n');
    expect((await ws.restore(2)).restored).toEqual(['src/a.ts']);
  });
});
