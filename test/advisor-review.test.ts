import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../src/agents/advisor.js', async (orig) => ({...(await orig<object>()), advisorRef: () => ({provider: 'claude', model: 'opus'})}));
const {Runtime} = await import('../src/runtime.js');

/** What stopHook reads for verify-requirements, plus a reviewer that reports one problem. */
function runtime(experiments: string[]) {
  const r = Object.create(Runtime.prototype);
  const messages = [{role: 'user', text: 'Implement BigInt'}];
  r.config = {experiments};
  r.engine = {transcript: {id: 't', messages}};
  r.checkpoints = {changedSince: () => ['bigint.go']};
  r.snapshots = {changedSince: async () => []};
  r.currentTurn = () => 0;
  r.lsp = {turnEnd: async () => undefined};
  r.verifyPasses = 0;
  r.keptGoing = 0;
  r.reviewers = [] as unknown[];
  r.crossReview = async (by: unknown) => (r.reviewers.push(by), 'A second model (claude:opus) reviewed your change and reported:\nbigint.go: 0n ** 0n is not 1n');
  return {r: r as InstanceType<typeof Runtime> & {reviewers: unknown[]}, messages};
}

const cwd = process.cwd();
beforeEach(() => process.chdir(mkdtempSync(path.join(os.tmpdir(), 'rein-review-'))));
afterEach(() => process.chdir(cwd));

describe('advisor-review', () => {
  it("adds the advisor's review of the diff to the first requirement check, once", async () => {
    const {r, messages} = runtime(['verify-requirements', 'advisor-review']);
    const first = (await r.stopHook(false))?.reason ?? '';
    expect(first).toMatch(/line by line/);
    expect(first).toMatch(/0n \*\* 0n/);
    expect(r.reviewers).toEqual([{provider: 'claude', model: 'opus'}]);
    messages.push({role: 'user', text: '<stop_hook>…'}, {role: 'assistant', text: 'Fixed.'});
    expect((await r.stopHook(true))?.reason).toMatch(/changed the code while checking/);
    expect(r.reviewers).toHaveLength(1);
  });

  it('is off unless listed', async () => {
    const {r} = runtime(['verify-requirements']);
    expect((await r.stopHook(false))?.reason).not.toMatch(/0n \*\* 0n/);
    expect(r.reviewers).toHaveLength(0);
  });
});
