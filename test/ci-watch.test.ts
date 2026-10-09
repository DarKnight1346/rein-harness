import {describe, expect, it} from 'vitest';
import {CiWatcher, runId, summary, type Check} from '../src/build/ci.js';

const check = (name: string, bucket: string, run = 1): Check => ({name, bucket, link: `https://github.com/acme/app/actions/runs/${run}/job/9`, workflow: 'CI'});

/** A watcher fed a scripted sequence of check results. */
function watcher(seq: Check[][]) {
  const logs: string[] = [];
  const tasks: string[] = [];
  const w = new CiWatcher({
    log: (t) => logs.push(t),
    submit: (t) => tasks.push(t),
    checks: async () => ({checks: seq.shift() ?? []}),
    task: async (_root, fails, round, max) => `fix ${fails.map((f) => f.name).join(',')} (${round}/${max})`,
  });
  return {w, logs, tasks};
}

describe('CI watcher', () => {
  it('waits for checks to finish, hands failures to the agent once per run, and stops when CI passes', async () => {
    const {w, logs, tasks} = watcher([
      [check('test', 'pending'), check('lint', 'pass')],
      [check('test', 'fail'), check('lint', 'pass')],
      [check('test', 'fail'), check('lint', 'pass')], // the same failed run: not again
      [check('test', 'fail', 2), check('lint', 'pass', 2)], // a new run after the fix, still failing
      [check('test', 'pass', 3), check('lint', 'pass', 3)],
    ]);
    for (let i = 0; i < 5; i++) await w.tick('/repo');
    expect(tasks).toEqual(['fix test (1/3)', 'fix test (2/3)']);
    expect(logs.at(-1)).toBe('CI passed (2 checks: 2 passed). Stopped watching.');
  });

  it('gives up after a few rounds', async () => {
    const {w, logs, tasks} = watcher([1, 2, 3, 4].map((n) => [check('test', 'fail', n)]));
    for (let i = 0; i < 4; i++) await w.tick('/repo');
    expect(tasks).toHaveLength(3);
    expect(logs.at(-1)).toMatch(/still failing after 3 fix rounds.*over to you/);
  });

  it('reads run ids from check links and summarizes', () => {
    expect(runId('https://github.com/a/b/actions/runs/123456/job/789')).toBe('123456');
    expect(runId('https://ci.example.com/x')).toBeUndefined();
    expect(summary([check('a', 'pass'), check('b', 'fail'), check('c', 'pending')])).toBe('3 checks: 1 passed, 1 failed, 1 running');
  });
});
