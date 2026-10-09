import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const calls: {ref: unknown; system: string; prompt: string}[] = [];
let reply = 'Step 3 runs the migration before the backfill it depends on';
vi.mock('../src/decider/index.js', async (orig) => ({
  ...((await orig()) as object),
  completeWith: async (ref: unknown, _cfg: unknown, system: string, prompt: string) => (calls.push({ref, system, prompt}), reply),
}));
const {Runtime} = await import('../src/runtime.js');
const {presentPlanTool} = await import('../src/tools/plan.js');

function runtime(planReview: string) {
  const r = Object.create(Runtime.prototype) as InstanceType<typeof Runtime>;
  (r as any).config = {planReview, maxUsedPct: 100, advisorModel: 'off'};
  (r as any).engine = {transcript: {id: 't', messages: [{role: 'user', text: 'Split the users table'}]}, currentRef: () => ({provider: 'claude', model: 'opus'})};
  (r as any).reviewerFor = () => ({provider: 'codex', model: 'gpt-5.5'});
  return r;
}

const cwd = process.cwd();
beforeEach(() => {
  calls.length = 0;
  reply = 'Step 3 runs the migration before the backfill it depends on';
  process.chdir(mkdtempSync(path.join(os.tmpdir(), 'rein-pr-')));
});
afterEach(() => process.chdir(cwd));

describe('plan review by a second model', () => {
  it("has the other provider critique the plan once per planning session, before the user sees it", async () => {
    const r = runtime('other');
    r.planMode = true;
    const msg = await r.reviewPlan('plan', '# Split users\n1. migrate\n2. backfill');
    expect(calls[0]!.ref).toEqual({provider: 'codex', model: 'gpt-5.5'});
    expect(calls[0]!.prompt).toMatch(/The request:\nSplit the users table[\s\S]*The plan:\n# Split users/);
    expect(msg).toMatch(/^Before the user sees it, a second model \(codex:gpt-5\.5\) reviewed your plan and reported:\nStep 3 runs the migration[\s\S]*call present_plan again/);
    expect(await r.reviewPlan('plan', 'revised')).toBeUndefined(); // once per session
    r.planMode = false;
    r.planMode = true; // a new planning session
    reply = 'NONE';
    expect(await r.reviewPlan('plan', 'another')).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('is off by default, and the plan tool shows the critique to the agent instead of the user', async () => {
    const r = runtime('off');
    r.planMode = true;
    expect(await r.reviewPlan('plan', 'x')).toBeUndefined();
    expect(calls).toEqual([]);
    let reviewed = false;
    const presented: string[] = [];
    const tool = presentPlanTool({
      active: () => true,
      root: () => process.cwd(),
      present: async (p) => (presented.push(p.title), 'save'),
      review: async () => (reviewed ? undefined : ((reviewed = true), 'a second model reported: step 2 is wrong')),
      done: () => {},
    });
    const args = {title: 'Split users', plan: 'Goal: split the users table into two.', milestones: ['tables split']};
    expect((await tool.run({} as any, args)).text).toBe('a second model reported: step 2 is wrong');
    expect(presented).toEqual([]);
    expect((await tool.run({} as any, args)).text).toMatch(/Plan saved/);
    expect(presented).toEqual(['Split users']);
  });
});
