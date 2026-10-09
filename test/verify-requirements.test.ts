import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Runtime} from '../src/runtime.js';

/** Just what stopHook reads for verify-requirements: config, files changed this turn, a quiet code check. */
function runtime(experiments: string[], changed: string[]) {
  const r = Object.create(Runtime.prototype);
  r.config = {experiments};
  r.engine = {transcript: {id: 't', messages: [{role: 'user', text: 'Implement BigInt'}]}};
  r.checkpoints = {changedSince: () => changed};
  r.currentTurn = () => 0;
  r.lsp = {turnEnd: async () => undefined};
  r.verified = false;
  r.keptGoing = 0;
  return r as InstanceType<typeof Runtime>;
}

const cwd = process.cwd();
beforeEach(() => process.chdir(mkdtempSync(path.join(os.tmpdir(), 'rein-verify-')))); // no Stop hooks here
afterEach(() => process.chdir(cwd));

describe('verify-requirements', () => {
  it('sends the agent back once per request to run each requirement, after it changed files', async () => {
    const r = runtime(['verify-requirements'], ['bigint.go']);
    expect((await r.stopHook(false))?.reason).toMatch(/run it: .*rereading the code is not/);
    expect(await r.stopHook(false)).toBeUndefined();
  });

  it("is off unless listed, and skipped when nothing changed", async () => {
    expect(await runtime([], ['bigint.go']).stopHook(false)).toBeUndefined();
    expect(await runtime(['verify-requirements'], []).stopHook(false)).toBeUndefined();
  });
});
