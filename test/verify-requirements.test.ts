import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Runtime} from '../src/runtime.js';

/**
 * Just what stopHook reads for verify-requirements: config, files changed since a message (Rein's
 * own edits, and the tree snapshot for shell edits), a quiet code check.
 */
function runtime(experiments: string[], edits: Record<number, string[]>, shell: Record<number, string[]> = {}) {
  const r = Object.create(Runtime.prototype);
  const messages = [{role: 'user', text: 'Implement BigInt'}];
  const since = (by: Record<number, string[]>) => (turn: number) => Object.entries(by).flatMap(([t, f]) => (Number(t) >= turn ? f : []));
  r.config = {experiments};
  r.engine = {transcript: {id: 't', messages}};
  r.checkpoints = {changedSince: since(edits)};
  r.snapshots = {changedSince: async (turn: number) => since(shell)(turn)};
  r.currentTurn = () => 0;
  r.lsp = {turnEnd: async () => undefined};
  r.verifyPasses = 0;
  r.keptGoing = 0;
  return {r: r as InstanceType<typeof Runtime>, messages};
}

const cwd = process.cwd();
beforeEach(() => process.chdir(mkdtempSync(path.join(os.tmpdir(), 'rein-verify-')))); // no Stop hooks here
afterEach(() => process.chdir(cwd));

describe('verify-requirements', () => {
  it('sends the agent back once per request to run each requirement, after it changed files', async () => {
    const {r, messages} = runtime(['verify-requirements'], {0: ['bigint.go']});
    expect((await r.stopHook(false))?.reason).toMatch(/run it: .*rereading the code is not/);
    messages.push({role: 'user', text: '<stop_hook>…'}, {role: 'assistant', text: 'All pass.'});
    expect(await r.stopHook(true)).toBeUndefined(); // the check changed nothing
    expect(await r.stopHook(false)).toBeUndefined();
  });

  it('counts changes made through the shell, and checks again once when the check changed the code', async () => {
    const {r, messages} = runtime(['verify-requirements'], {}, {0: ['bigint.go'], 1: ['bigint.go']});
    expect((await r.stopHook(false))?.reason).toMatch(/line by line/);
    messages.push({role: 'user', text: '<stop_hook>…'}, {role: 'assistant', text: 'Fixed the edge case.'});
    expect((await r.stopHook(true))?.reason).toMatch(/changed the code while checking/);
    messages.push({role: 'user', text: '<stop_hook>…'}, {role: 'assistant', text: 'Fixed again.'});
    expect(await r.stopHook(true)).toBeUndefined(); // two at most
  });

  it('is on by default, off with -verify-requirements, and skipped when nothing changed', async () => {
    expect(await runtime([], {0: ['bigint.go']}).r.stopHook(false)).toBeDefined();
    expect(await runtime(['-verify-requirements'], {0: ['bigint.go']}).r.stopHook(false)).toBeUndefined();
    expect(await runtime(['verify-requirements'], {}).r.stopHook(false)).toBeUndefined();
  });
});
