import {describe, expect, it, vi} from 'vitest';

const asked: any[] = [];
vi.mock('../src/decider/index.js', () => ({
  decide: async (_cfg: unknown, state: unknown, questions: Record<string, any>) => {
    asked.push({state, questions});
    return {
      backend: 'test',
      answers: Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [id, q.type === 'noul' ? {type: 'noul', noul: 0.8} : q.type === 'choice' ? {type: 'choice', choice: Object.keys(q.criteria)[1], confidence: 0.7} : {type: 'score', score: 2, confidence: 0.9}]),
      ),
    };
  },
}));
const {decideTool} = await import('../src/decider/tool.js');
const {DEFAULT_CONFIG} = await import('../src/store/config.js');

describe('decide tool', () => {
  const t = decideTool(() => DEFAULT_CONFIG);
  it('maps yes/no, choice and score questions to the decision model and formats the answers', async () => {
    const r = await t.run({root: '/'} as any, {
      context: 'four failures…',
      questions: [
        {id: 'blocker', type: 'yes_no', question: 'Release blocker?', yes: 'must fix first'},
        {type: 'choice', question: 'Kind?', options: ['code_bug', 'infra', 'flaky']},
        {id: 'sev', type: 'score', question: 'Severity?', scale: ['trivial', 'minor', 'serious', 'blocking']},
      ],
    });
    expect(asked[0].state).toEqual({context: 'four failures…'});
    expect(asked[0].questions.blocker).toEqual({type: 'noul', instructions: 'Release blocker?', criteria: {true: 'must fix first', false: 'no'}});
    expect(asked[0].questions.q2.criteria).toEqual({code_bug: 'code_bug', infra: 'infra', flaky: 'flaky'});
    expect(r.text).toBe('blocker: yes (p(yes) = 0.80)\nq2: infra (confidence 0.70)\nsev: 2.00 on 0–3 ≈ "serious" (confidence 0.90)\n(via test)');
  });

  it('rejects malformed questions', async () => {
    await expect(t.run({root: '/'} as any, {context: 'x', questions: []})).rejects.toThrow(/questions is required/);
    await expect(t.run({root: '/'} as any, {context: 'x', questions: [{type: 'choice', question: 'a?', options: ['only']}]})).rejects.toThrow(/at least 2 options/);
    await expect(t.run({root: '/'} as any, {context: 'x', questions: [{type: 'vibes', question: 'a?'}]})).rejects.toThrow(/type must be/);
  });
});
