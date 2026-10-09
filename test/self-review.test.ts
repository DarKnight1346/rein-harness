import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Runtime} from '../src/runtime.js';

function runtime(experiments: string[]) {
  const r = Object.create(Runtime.prototype);
  const reviews: unknown[][] = [];
  r.config = {experiments: ['-verify-requirements', ...experiments]};
  r.engine = {transcript: {id: 't', messages: [{role: 'user', text: 'Add rate limiting'}]}, currentRef: () => ({provider: 'claude', model: 'sonnet'})};
  r.checkpoints = {changedSince: () => ['src/limit.ts']};
  r.snapshots = {changedSince: async () => []};
  r.currentTurn = () => 0;
  r.lsp = {turnEnd: async () => undefined};
  r.keptGoing = 0;
  r.crossReview = async (...a: unknown[]) => (reviews.push(a), 'A fresh review of your change … reported:\nsrc/limit.ts: the window never resets');
  return {r: r as InstanceType<typeof Runtime>, reviews};
}

const cwd = process.cwd();
beforeEach(() => process.chdir(mkdtempSync(path.join(os.tmpdir(), 'rein-sr-'))));
afterEach(() => process.chdir(cwd));

describe('self-review', () => {
  it('has the same model review the change once per request, without the conversation', async () => {
    const {r, reviews} = runtime(['self-review']);
    expect((await r.stopHook(false))?.reason).toMatch(/the window never resets/);
    expect(reviews).toEqual([[{provider: 'claude', model: 'sonnet'}, 'A fresh review of your change (the same model, without this conversation)']]);
    expect(await r.stopHook(false)).toBeUndefined(); // once per request
  });

  it('is off unless listed', async () => {
    const {r, reviews} = runtime([]);
    expect(await r.stopHook(false)).toBeUndefined();
    expect(reviews).toEqual([]);
  });
});
