import {mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {Runtime} from '../src/runtime.js';

function runtime(experiments: string[], file: string) {
  const r = Object.create(Runtime.prototype);
  r.config = {experiments: ['-verify-requirements', ...experiments]};
  r.engine = {transcript: {id: 't', messages: [{role: 'user', text: 'Drop the total field'}]}, currentRef: () => ({provider: 'claude', model: 'sonnet'})};
  r.checkpoints = {changedSince: () => [file], before: () => 'message Order { string id = 1; int64 total = 2; }'};
  r.snapshots = {changedSince: async () => []};
  r.currentTurn = () => 0;
  r.lsp = {turnEnd: async () => undefined};
  r.keptGoing = 0;
  return r as InstanceType<typeof Runtime>;
}

const cwd = process.cwd();
let dir: string;
beforeEach(() => process.chdir((dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-cc-'))))));
afterEach(() => process.chdir(cwd));

describe('contract-check', () => {
  it('tells the agent, once per request, that its change breaks a contract', async () => {
    const f = path.join(dir, 'order.proto');
    writeFileSync(f, 'message Order { string id = 1; }');
    const r = runtime(['contract-check'], f);
    expect((await r.stopHook(false))?.reason).toMatch(/^Your change breaks API contracts[\s\S]*Order\.total \(= 2\): field removed without reserving its number/);
    expect(await r.stopHook(false)).toBeUndefined();
  });

  it('is off unless listed', async () => {
    const f = path.join(dir, 'order.proto');
    writeFileSync(f, 'message Order { string id = 1; }');
    expect(await runtime([], f).stopHook(false)).toBeUndefined();
  });
});
