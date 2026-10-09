import {mkdtempSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {estimateGoalCost} from '../src/goals/estimate.js';
import {newTranscript, saveTranscript} from '../src/session/transcript.js';

const home = process.env.REIN_HOME;
let cwd: string;
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-est-'));
  cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-proj-')));
});
afterEach(() => {
  if (home === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = home;
});

/** A conversation in the project with a goal that cost `cost` (or is still active). */
async function goal(cost: number, status: 'done' | 'active' = 'done', where = cwd) {
  const t = newTranscript();
  t.cwd = where;
  t.messages.push({role: 'user', text: 'do it', at: Date.now()});
  t.goal = {text: 'x', status, createdAt: 0, since: 0, rounds: 0, escalations: 0, checks: [], startUsd: 1, ...(status === 'done' ? {endUsd: 1 + cost} : {})};
  await saveTranscript(t);
}

describe('goal cost estimates', () => {
  it("are the median and range of this project's finished goals", async () => {
    for (const c of [2, 8, 3, 50]) await goal(c);
    await goal(999, 'active'); // not finished: not counted
    await goal(500, 'done', os.tmpdir()); // another project
    expect(await estimateGoalCost(cwd)).toEqual({median: 5.5, low: 2, high: 50, n: 4});
  });

  it('wait for a few finished goals before guessing', async () => {
    await goal(4);
    await goal(6);
    expect(await estimateGoalCost(cwd)).toBeUndefined();
  });
});
