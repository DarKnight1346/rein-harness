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
