import {execFileSync} from 'node:child_process';
import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {addedLinesByFile, parseCoverage, ranges, uncoveredChanges} from '../src/build/coverage.js';

describe('coverage of changes', () => {
  it('reads lcov, Istanbul, Cobertura and Go reports', () => {
    expect([...parseCoverage('lcov.info', 'SF:src/a.ts\nDA:1,3\nDA:2,0\nend_of_record\n').get('src/a.ts')!]).toEqual([[1, 3], [2, 0]]);
    const ist = JSON.stringify({'/repo/src/b.ts': {path: '/repo/src/b.ts', statementMap: {0: {start: {line: 4}}, 1: {start: {line: 9}}}, s: {0: 1, 1: 0}}});
    expect([...parseCoverage('coverage-final.json', ist).get('/repo/src/b.ts')!]).toEqual([[4, 1], [9, 0]]);
    expect([...parseCoverage('coverage.xml', '<class name="c" filename="app/c.py"><lines><line number="7" hits="0"/><line number="8" hits="2"/></lines></class>').get('app/c.py')!]).toEqual([[7, 0], [8, 2]]);
    expect([...parseCoverage('coverage.out', 'mode: set\nexample.com/m/pkg/d.go:3.2,5.10 2 0\n').get('example.com/m/pkg/d.go')!]).toEqual([[3, 0], [4, 0], [5, 0]]);
  });

  it('lists changed lines no test ran, matching report paths to project files', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-cov-')));
    const git = (...a: string[]) => execFileSync('git', a, {cwd: root, stdio: 'ignore'});
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nthree\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(path.join(root, 'a.ts'), 'one\ntwo\nNEW\nNEWER\nthree\n');
    writeFileSync(path.join(root, 'b.ts'), 'x\ny\n');
    const added = await addedLinesByFile(root);
    expect(added.get('a.ts')).toEqual([3, 4]);
    expect(added.get('b.ts')).toEqual([1, 2, 3]);
    const hits = parseCoverage('lcov.info', `SF:${path.join(root, 'a.ts')}\nDA:3,0\nDA:4,5\nend_of_record\nSF:b.ts\nDA:1,0\nDA:2,0\nend_of_record\n`);
    expect(uncoveredChanges(hits, root, added)).toEqual([{file: 'a.ts', lines: [3]}, {file: 'b.ts', lines: [1, 2]}]);
    expect(ranges([1, 2, 3, 7, 9, 10])).toBe('1-3, 7, 9-10');
  });
});
