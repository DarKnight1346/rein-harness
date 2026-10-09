import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {changeSetState, dependencyOrder, formatState, formatTests, loadChangeSets, openPrs, startChangeSet, testChangeSet} from '../src/system/changeset.js';
import {findWorkspace} from '../src/workspace/index.js';

function workspace() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-cs-')));
  for (const repo of ['api', 'web']) {
    const dir = path.join(root, repo);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({scripts: {test: 'node -e 0'}}));
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: dir});
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'base');
  }
  writeFileSync(path.join(root, 'rein.workspace.yaml'), 'repos: [api, web]\n');
  return {root, ws: findWorkspace(root)!};
}

describe('coordinated change sets', () => {
  it('orders repos so the ones others call come first', () => {
    expect(dependencyOrder(['web', 'api', 'ledger'], [{from: 'web', to: 'api', kind: 'http', evidence: ''}, {from: 'api', to: 'ledger', kind: 'grpc', evidence: ''}])).toEqual(['ledger', 'api', 'web']);
    expect(dependencyOrder(['a', 'b'], [{from: 'a', to: 'b', kind: 'http', evidence: ''}, {from: 'b', to: 'a', kind: 'http', evidence: ''}])).toEqual(['b', 'a']);
  });

  it('starts one branch in each repo, tracks them, and tests them in dependency order', async () => {
    const {root, ws} = workspace();
    const {set, done, failed} = await startChangeSet(ws, 'split-users', ['api', 'web', 'nope']);
    expect([done, failed]).toEqual([['api', 'web'], ['nope: not a cloned repo of this workspace']]);
    expect(loadChangeSets(ws).map((s) => s.name)).toEqual(['split-users']);
    expect(execFileSync('git', ['branch', '--show-current'], {cwd: path.join(root, 'web')}).toString().trim()).toBe('split-users');
    writeFileSync(path.join(root, 'api', 'x.ts'), 'x');
    expect(formatState(set, await changeSetState(ws, set))).toBe('Change set split-users (branch split-users):\n  ✓ api  0 commits, 1 uncommitted\n  ✓ web  0 commits');
    const ran: string[] = [];
    const results = await testChangeSet(ws, set, [{from: 'web', to: 'api', kind: 'http', evidence: ''}], async (cmd, cwd) => (ran.push(`${path.basename(cwd)}: ${cmd}`), {ok: path.basename(cwd) === 'api', output: 'FAIL cart.test.ts'}));
    expect(ran).toEqual(['api: npm test', 'web: npm test']);
    expect(formatTests(results)).toBe('1 of 2 repos failed:\n  ✓ api  npm test\n  ✗ web  npm test\n      FAIL cart.test.ts');
    const prs = await openPrs(ws, set, 'Split users');
    expect(prs.opened).toEqual([]);
    expect(prs.failed.map((f) => f.split(':')[0])).toEqual(['api', 'web']); // no remote to push to
  });
});
