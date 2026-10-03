import {describe, expect, it} from 'vitest';
import {askUserTool, type AskQuestion} from '../src/tools/ask.js';
import {presentPlanTool, readOnlyCommand} from '../src/tools/plan.js';
import {loadSkills} from '../src/skills/index.js';

describe('plan mode', () => {
  it('lets only read-only shell commands through', () => {
    for (const c of ['ls -la', 'git status', 'git log --oneline -5', 'rg TODO src | head -20', 'cat a.ts && wc -l a.ts', 'npm ls react', 'make 2>&1 >/dev/null'.replace('make', 'ls')]) expect(readOnlyCommand(c)).toBe(true);
    for (const c of ['rm -rf dist', 'npm install', 'git commit -m x', 'echo hi > out.txt', 'cat a >> b', 'find . -delete', 'git config user.name x', 'sed -i s/a/b/ f', 'ls $(rm x)']) expect(readOnlyCommand(c)).toBe(false);
  });

  it('present_plan returns the decision and turns plan mode off when approved', async () => {
    let active = true;
    let decided = '';
    const t = presentPlanTool({active: () => active, scratch: () => undefined, present: async () => 'approve-all', done: (d) => ((decided = d), (active = false))});
    const r = await t.run({} as any, {plan: '## Goal\nAdd a flag.\n1. Edit cli.ts\n2. Test'});
    expect(r.text).toMatch(/approved .* allowed all changes .* carry it out/);
    expect(decided).toBe('approve-all');
    await expect(t.run({} as any, {plan: 'x'.repeat(40)})).rejects.toThrow(/plan mode is off/);
  });

  it('/plan and /plan:deep are built-in skills that turn plan mode on', () => {
    const skills = loadSkills('/tmp');
    expect(skills.find((s) => s.name === 'plan')?.planMode).toBe(true);
    const deep = skills.find((s) => s.name === 'plan:deep');
    expect(deep?.planMode).toBe(true);
    expect(deep?.body).toMatch(/advisor/i);
    expect(deep?.body).toMatch(/ask_user/);
  });
});

describe('ask_user', () => {
  const qs = [
    {id: 'db', question: 'Which database?', options: [{label: 'Postgres'}, {label: 'SQLite'}]},
    {id: 'features', question: 'Which features?', options: ['auth', 'billing', 'search'], multi: true},
  ];
  it('collects every answer, including typed "something else" answers', async () => {
    let seen: AskQuestion[] = [];
    const t = askUserTool(() => async (q) => ((seen = q), [{id: 'db', selected: [], other: 'MySQL 8, it is what ops runs'}, {id: 'features', selected: ['auth', 'search']}]));
    const r = await t.run({} as any, {questions: qs});
    expect(seen[1]!.multi).toBe(true);
    expect(seen[1]!.options.map((o) => o.label)).toEqual(['auth', 'billing', 'search']);
    expect(r.text).toContain('Which database?\n→ (their own answer) MySQL 8, it is what ops runs');
    expect(r.text).toContain('Which features?\n→ auth; search');
  });
  it('dismissed, headless and malformed cases', async () => {
    expect((await askUserTool(() => async () => undefined).run({} as any, {questions: qs})).text).toMatch(/dismissed/);
    expect((await askUserTool(() => undefined).run({} as any, {questions: qs})).text).toMatch(/headless/);
    await expect(askUserTool(() => undefined).run({} as any, {questions: [{question: 'x?', options: ['only']}]})).rejects.toThrow(/at least 2 options/);
  });
});
