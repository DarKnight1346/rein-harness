import {mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {listPlans, progress, readPlan, savePlan, setMilestone} from '../src/plans/store.js';
import {GoalManager} from '../src/goals/manager.js';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-plans-')));
});

describe('saved plans', () => {
  it('saves markdown with a milestone checklist (replacing one in the body), ticks and lists them', () => {
    const file = savePlan(root, {title: 'Hobby OS', plan: '# Old title\n## Goal\nBoot.\n## Milestones\n- [ ] stale', milestones: ['toolchain', 'bootloader', 'kernel']});
    expect(file.replace(/\\/g, '/')).toMatch(/\.rein\/plans\/\d{4}-\d\d-\d\d-hobby-os\.md$/);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('# Hobby OS\n')).toBe(true);
    expect(text).not.toContain('stale');
    setMilestone(file, 1, true);
    const p = readPlan(file)!;
    expect(p.milestones.map((m) => m.done)).toEqual([false, true, false]);
    expect(progress(p)).toEqual({done: 1, total: 3, pct: 33});
    const second = savePlan(root, {title: 'Hobby OS', plan: '## Goal\nAgain.', milestones: ['one']});
    expect(second).not.toBe(file);
    setMilestone(second, 0, true);
    expect(listPlans(root).filter((x) => !x.complete).map((x) => x.file)).toEqual([file]);
  });
});

describe('goals from a plan', () => {
  const setup = (verdict: number) => {
    const t: any = {id: 't', messages: [{role: 'user', text: 'go', at: 0}]};
    const goals = new GoalManager({
      maxRounds: () => 0,
      transcript: () => t,
      save: () => {},
      decide: async () => ({answers: {achieved: {type: 'noul', noul: verdict}}, backend: 'test'}) as any,
      advise: async () => undefined,
      investigate: async () => '',
    });
    const file = savePlan(root, {title: 'Shout', plan: '## Goal\nShout.', milestones: ['flag parsed', 'tests pass']});
    goals.set('Carry out the plan "Shout"', file);
    return {goals, file};
  };

  it('kickoff and reminders list the milestones; goal_done waits for all of them', async () => {
    const {goals, file} = setup(0.95);
    expect(goals.kickoff(goals.goal!)).toContain('→ 1. flag parsed');
    expect((await goals.reviewClaim('done', 'all good')).note).toMatch(/milestones not done yet: 1\. flag parsed; 2\. tests pass/);
    expect((await goals.reviewMilestone(1, 'node cli.js --shout hi → HI')).accepted).toBe(true);
    expect(readPlan(file)!.milestones[0]!.done).toBe(true);
    expect((await goals.next())!.message).toContain('✓ 1. flag parsed\n→ 2. tests pass');
    await goals.reviewMilestone(2, 'npm test: 5 passed');
    expect((await goals.reviewClaim('done', 'all checks pass')).accepted).toBe(true);
  });

  it('a milestone without evidence stays open', async () => {
    const {goals, file} = setup(0.2);
    const r = await goals.reviewMilestone(1, 'I think it works');
    expect(r.accepted).toBe(false);
    expect(readPlan(file)!.milestones[0]!.done).toBe(false);
  });
});
