import {mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {listPlans, progress, readPlan, savePlan, setMilestone} from '../src/plans/store.js';
import {GoalManager} from '../src/goals/manager.js';
import {milestoneDoneTool} from '../src/goals/tool.js';
import {isMilestoneCopy, sameTask, todoTool} from '../src/tools/todo.js';

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

  it('tasks copied from the milestones are flagged, and completed when the milestone is', async () => {
    const {goals} = setup(0.95);
    const milestones = goals.plan()!.milestones.map((m) => m.text);
    expect(sameTask('Parse the flag', 'flag parsed')).toBe(false); // different words: kept
    expect(sameTask('Tests pass', 'tests pass')).toBe(true);
    expect(sameTask('Add the --shout flag to the CLI parser', 'Add --shout flag to CLI parser')).toBe(true);
    expect(sameTask('Write the docs page', 'Add --shout flag to CLI parser')).toBe(false);
    const t: any = {todos: []};
    const todo = todoTool({transcript: () => t, changed: () => {}, milestones: () => milestones});
    const r = await todo.run({} as any, {todos: [{content: 'flag parsed', status: 'in_progress'}, {content: 'Tests pass', status: 'pending'}, {content: 'Read cli.ts', status: 'pending'}]});
    expect(r.text).toContain("2 of these repeat the plan's milestones");
    expect(t.todos.filter((x: any) => !isMilestoneCopy(x, milestones)).map((x: any) => x.content)).toEqual(['Read cli.ts']); // what the sidebar shows
    const done: string[] = [];
    await milestoneDoneTool(goals, (m) => done.push(m)).run({} as any, {milestone: 1, evidence: 'node cli.js --shout hi → HI'});
    expect(done).toEqual(['flag parsed']);
  });
});

describe('attribution', () => {
  it('asks for the Rein line in commits and PRs, unless turned off', async () => {
    const {ATTRIBUTION_LINE, setAttribution, systemPrompt} = await import('../src/session/prompt.js');
    expect(ATTRIBUTION_LINE).toBe('Co-Authored by [Rein Harness](https://github.com/DarKnight1346/rein-harness)');
    setAttribution(() => true);
    expect(await systemPrompt({tools: true})).toContain(`Every git commit you make must end with this line, after a blank line: ${ATTRIBUTION_LINE}`);
    setAttribution(() => false);
    expect(await systemPrompt({tools: true})).not.toContain(ATTRIBUTION_LINE);
    setAttribution(() => true);
  });
});
