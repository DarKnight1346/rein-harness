import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {formatBench, loadTasks, pickTasks, runBench, saveTasks} from '../src/insight/bench.js';

function history() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-bench-repo-')));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: root});
  const commit = (files: Record<string, string>, msg: string) => {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
      writeFileSync(path.join(root, f), t);
    }
    git('add', '-A');
    git('commit', '-qm', msg);
  };
  git('init', '-q');
  commit({'src/money.ts': 'export const add = (a, b) => a + b;\n', 'package.json': '{"scripts": {"test": "node test.js"}}'}, 'Start');
  commit({'README.md': 'docs\n'}, 'Docs only');
  commit({'src/money.ts': 'export const add = (a, b) => a + b;\nexport const cents = (d) => Math.round(d * 100);\n', 'src/money.test.ts': 'expect(cents(1.005)).toBe(101)\n'}, 'Add cents() to convert dollars to cents\n\nRound half up.');
  return root;
}

describe('rein bench', () => {
  it('turns commits that change code and tests into tasks', async () => {
    const root = history();
    const tasks = await pickTasks(root, 5);
    expect(tasks.map((t) => [t.prompt, t.files, t.tests])).toEqual([['Add cents() to convert dollars to cents\n\nRound half up.', ['src/money.ts'], ['src/money.test.ts']]]);
    saveTasks(root, tasks);
    expect(loadTasks(root)).toEqual(tasks);
  });

  it('runs each model on a clean copy at the parent, then judges with the commit’s own tests', async () => {
    const root = history();
    const tasks = await pickTasks(root, 5);
    const seen: {model: string; hasFuture: boolean; hasGitHistory: number}[] = [];
    const results = await runBench(root, tasks, ['claude:opus', 'codex:gpt-5.5'], {
      test: 'npm test',
      agent: async (_prompt, model, cwd) => {
        const log = execFileSync('git', ['log', '--oneline'], {cwd}).toString().trim().split('\n').length;
        seen.push({model, hasFuture: readFileSync(path.join(cwd, 'src/money.ts'), 'utf8').includes('cents'), hasGitHistory: log});
        if (model === 'claude:opus') writeFileSync(path.join(cwd, 'src/money.ts'), 'export const cents = (d) => Math.round(d * 100);\n');
        return {ok: true, usd: model === 'claude:opus' ? 0.4 : 0.1};
      },
      tester: async (_cmd, cwd) => existsSync(path.join(cwd, 'src/money.test.ts')) && readFileSync(path.join(cwd, 'src/money.ts'), 'utf8').includes('cents'),
    });
    expect(seen).toEqual([{model: 'claude:opus', hasFuture: false, hasGitHistory: 1}, {model: 'codex:gpt-5.5', hasFuture: false, hasGitHistory: 1}]);
    expect(results.map((r) => [r.model, r.passed, r.usd])).toEqual([['claude:opus', true, 0.4], ['codex:gpt-5.5', false, 0.1]]);
    expect(formatBench(results)).toMatch(/^1 task from this repo's history:\n  claude:opus +1\/1 passed \(100%\) · \d+s a task · \$0\.40 a task\n  codex:gpt-5\.5 +0\/1 passed \(0%\)/);
  });
});
