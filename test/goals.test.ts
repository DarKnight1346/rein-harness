import {describe, expect, it} from 'vitest';
import {GoalManager} from '../src/goals/manager.js';
import {goalDoneTool} from '../src/goals/tool.js';
import {newTranscript} from '../src/session/transcript.js';

function setup(opts: {noul: number[]; advisor?: string; maxRounds?: number}) {
  const t = newTranscript();
  const answers = [...opts.noul];
  const asked: string[] = [];
  let investigated = '';
  const g = new GoalManager({
    maxRounds: () => opts.maxRounds ?? 0,
    transcript: () => t,
    save: () => {},
    decide: async (_state, questions) => {
      asked.push(Object.keys(questions)[0]!);
      return {answers: {[Object.keys(questions)[0]!]: {type: 'noul', noul: answers.shift() ?? 0}}, backend: 'test'};
    },
    advise: async () => opts.advisor,
    investigate: async (task) => ((investigated = task), 'SUBAGENT PLAN'),
  });
  return {t, g, asked, investigated: () => investigated};
}

describe('goals', () => {
  it('set / pause / resume / clear', () => {
    const {g} = setup({noul: []});
    g.set('ship it');
    expect(g.goal?.status).toBe('active');
    expect(g.pause()).toBe(true);
    expect(g.goal?.status).toBe('paused');
    expect(g.resume()).toBe(true);
    expect(g.clear()).toBe(true);
    expect(g.goal).toBeUndefined();
  });

  it('done claims need evidence: rejected below 0.7, accepted above', async () => {
    const {t, g} = setup({noul: [0.3, 0.9]});
    g.set('tests pass');
    t.messages.push({role: 'assistant', text: 'done', at: 1, tools: [{label: 'Shell', summary: '$ npm test', ok: true, result: '42 passed'}]});
    const tool = goalDoneTool(g);
    expect(tool.enabled!()).toBe(true);
    const first = await tool.run({root: '/'}, {summary: 'fixed', evidence: 'trust me'});
    expect(first.ok).toBe(false);
    expect(g.goal?.status).toBe('active');
    const second = await tool.run({root: '/'}, {summary: 'fixed', evidence: 'npm test: 42 passed'});
    expect(second.ok).toBe(true);
    expect(g.goal?.status).toBe('done');
    expect(tool.enabled!()).toBe(false); // no more goal_done once done
    expect(g.goal?.checks.map((c) => c.verdict)).toEqual(['rejected (0.30 via test)', 'accepted (0.90 via test)']);
  });

  it('continues normally; giving up escalates to the advisor, else a subagent', async () => {
    const withAdvisor = setup({noul: [0.1, 0.95], advisor: 'TRY X'});
    withAdvisor.g.set('make it work');
    expect((await withAdvisor.g.next())!.message).toContain('<goal_reminder>');
    const esc = await withAdvisor.g.next();
    expect(esc!.note).toMatch(/asked the advisor/);
    expect(esc!.message).toContain('TRY X');
    expect(esc!.message).toContain('"Impossible" is not a completion');

    const noAdvisor = setup({noul: [0.95]});
    noAdvisor.g.set('make it work');
    const sub = await noAdvisor.g.next();
    expect(sub!.note).toMatch(/asked a subagent/);
    expect(sub!.message).toContain('SUBAGENT PLAN');
    expect(noAdvisor.investigated()).toContain('make it work');
    expect(noAdvisor.g.goal?.escalations).toBe(1);
  });

  it('is unlimited by default; a configured cap pauses it', async () => {
    const free = setup({noul: []});
    free.g.set('forever');
    free.g.goal!.rounds = 10_000;
    expect(await free.g.next()).toBeDefined();
    expect(free.g.goal?.status).toBe('active');
    const capped = setup({noul: [], maxRounds: 3});
    capped.g.set('bounded');
    capped.g.goal!.rounds = 3;
    expect(await capped.g.next()).toBeUndefined();
    expect(capped.g.goal?.status).toBe('paused');
    expect(capped.g.resume()).toBe(true);
    expect(capped.g.goal?.rounds).toBe(0);
  });
});
