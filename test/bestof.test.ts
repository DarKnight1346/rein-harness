import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {bestOf, detectTestCommand, formatBestOf, pickWinner, type BestOfDeps} from '../src/agents/bestOf.js';
import {Worktrees} from '../src/agents/worktrees.js';

let home: string;
const envHome = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_HOME = home;
});
afterEach(() => {
  if (envHome === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = envHome;
  rmSync(home, {recursive: true, force: true});
});

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-bo-')));

function fake(results: Record<number, {lines?: number; pass?: boolean}>) {
  const events: string[] = [];
  let next = 1;
  const deps: BestOfDeps = {
    spawn: (_t, model) => {
      const id = next++;
      events.push(`spawn ${id} ${model}`);
      return {id, done: Promise.resolve({status: 'done', output: 'report'})};
    },
    hold: (id) => events.push(`hold ${id}`),
    result: async (id) => (results[id]?.lines ? {root: `/wt/${id}`, lines: results[id]!.lines!} : undefined),
    test: async (cmd, root) => (events.push(`test ${cmd} in ${root}`), {ok: !!results[Number(root.slice(4))]?.pass, output: 'FAIL charge.test.ts'}),
    release: async (id, keep) => (events.push(`${keep ? 'keep' : 'drop'} ${id}`), keep ? 'Merged 2 files.' : undefined),
    log: () => {},
  };
  return {deps, events};
}
const CONTENDERS = [{label: 'Claude', model: 'claude:opus'}, {label: 'Codex', model: 'codex:gpt-5.5'}];

describe('best-of-N across providers', () => {
  it('runs both at once, tests each, keeps the passing one and drops the other', async () => {
    const {deps, events} = fake({1: {lines: 40, pass: false}, 2: {lines: 60, pass: true}});
    const r = await bestOf(deps, 'add retries', CONTENDERS, 'npm test');
    expect(events).toEqual(['spawn 1 claude:opus', 'hold 1', 'spawn 2 codex:gpt-5.5', 'hold 2', 'test npm test in /wt/1', 'test npm test in /wt/2', 'drop 1', 'keep 2']);
    expect(formatBestOf(r, 'npm test')).toBe("Kept Codex's result: its tests passed. The other was deleted.\n  · Claude (claude:opus): 40 lines changed, npm test failed\n  ✓ Codex (codex:gpt-5.5): 60 lines changed, npm test passed\nMerged 2 files.");
  });

  it('prefers the smaller change when both pass, and keeps nothing when neither does', async () => {
    expect(pickWinner([{label: 'A', model: 'a', status: 'done', lines: 90, passed: true}, {label: 'B', model: 'b', status: 'done', lines: 30, passed: true}])?.label).toBe('B');
    const {deps, events} = fake({1: {lines: 10, pass: false}, 2: {}});
    const r = await bestOf(deps, 'x', CONTENDERS, 'go test ./...');
    expect(events.filter((e) => /^(keep|drop)/.test(e))).toEqual(['drop 1', 'drop 2']);
    expect(formatBestOf(r, 'go test ./...')).toMatch(/^Neither result passed go test \.\/\.\.\., so neither was kept \(your project is unchanged\)\.\n  · Claude.*failed\n  · Codex \(codex:gpt-5\.5\): no changes\n\nClaude's test output \(end\):\nFAIL charge\.test\.ts$/);
  });

  it('finds the test command', () => {
    const root = tmp();
    expect(detectTestCommand(root)).toBeUndefined();
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({scripts: {test: 'echo "Error: no test specified" && exit 1'}}));
    writeFileSync(path.join(root, 'go.mod'), 'module x\n');
    expect(detectTestCommand(root)).toBe('go test ./...');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({scripts: {test: 'vitest run'}}));
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    expect(detectTestCommand(root)).toBe('pnpm test');
  });

  it("holds a contender's worktree past its end, then merges the winner and deletes the loser", async () => {
    const root = tmp();
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: root});
    git('init', '-q');
    writeFileSync(path.join(root, 'a.ts'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    const wts = new Worktrees(root, () => 's');
    wts.hold(1);
    wts.hold(2);
    const w1 = (await wts.ensure(1))!;
    const w2 = (await wts.ensure(2))!;
    writeFileSync(path.join(w1.root, 'a.ts'), 'one\nclaude\n');
    writeFileSync(path.join(w2.root, 'b.ts'), 'codex\n');
    expect(await wts.settle(1)).toBeUndefined(); // finished, but not merged
    expect(await wts.settle(2)).toBeUndefined();
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('one\n');
    expect(existsSync(`${w1.dir}.json`)).toBe(false); // never recovered unasked
    expect((await wts.heldResult(1))?.lines).toBe(1);
    expect((await wts.release(2, false))?.merged).toEqual([]);
    expect(existsSync(w2.dir)).toBe(false);
    expect((await wts.release(1, true))?.merged).toEqual(['a.ts']);
    expect([readFileSync(path.join(root, 'a.ts'), 'utf8'), existsSync(path.join(root, 'b.ts')), existsSync(w1.dir)]).toEqual(['one\nclaude\n', false, false]);
  }, 20_000); // two real worktrees, made, snapshotted and removed
});
