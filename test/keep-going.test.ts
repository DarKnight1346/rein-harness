import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const verdict = {p: 0.9, asked: 0};
vi.mock('../src/decider/index.js', async (orig) => ({
  ...(await orig<object>()),
  decide: async () => (verdict.asked++, {backend: 'test', answers: {unfinished: {type: 'noul', noul: verdict.p}}}),
}));
const {Runtime} = await import('../src/runtime.js');

/** Just what stopHook reads: config, the conversation, and a code check with nothing to report. */
function runtime(experiments: string[], reply: string) {
  const r = Object.create(Runtime.prototype);
  r.config = {experiments};
  r.engine = {transcript: {id: 't', messages: [{role: 'user', text: 'Implement the parser change'}, {role: 'assistant', text: reply}]}};
  r.lsp = {turnEnd: async () => undefined};
  r.keptGoing = 0;
  return r as InstanceType<typeof Runtime>;
}

const cwd = process.cwd();
beforeEach(() => {
  process.chdir(mkdtempSync(path.join(os.tmpdir(), 'rein-keep-'))); // no Stop hooks here
  verdict.p = 0.9;
  verdict.asked = 0;
});
afterEach(() => process.chdir(cwd));

describe('keep-going', () => {
  it('sends the agent back when it stopped partway on its own, a few times per request', async () => {
    const r = runtime(['keep-going'], "I've only partly done this, and the repo does not build right now.");
    for (let i = 0; i < 3; i++) expect((await r.stopHook(i > 0))?.reason).toMatch(/Keep going/);
    expect(await r.stopHook(true)).toBeUndefined(); // the limit
    expect(verdict.asked).toBe(3);
  });

  it("lets it stop when it's done or needs the user, and is off unless listed", async () => {
    verdict.p = 0.1;
    expect(await runtime(['keep-going'], 'Done: all tests pass.').stopHook(false)).toBeUndefined();
    verdict.p = 0.9;
    expect(await runtime([], "I've only partly done this.").stopHook(false)).toBeUndefined();
    expect(verdict.asked).toBe(1);
  });
});
