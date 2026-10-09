import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {graphProblems, nextStage, parseTasks, readSpec, readyTasks, writeStage} from '../src/specs/store.js';
import {specTools} from '../src/specs/tools.js';
import type {AskQuestion} from '../src/tools/ask.js';

let home: string;
const envHome = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_HOME = home;
});
afterEach(() => {
  if (envHome === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = envHome;
  rmSync(home, {recursive: true, force: true});
});

const TASKS = '# Tasks\n\n- [ ] T1: Add the retry queue (R1)\n- [ ] T2: Backoff policy (R1, R2) after: T1\n- [ ] **T3**: Metrics for retries (R2) after: T1\n- [x] T4. Docs — after T2 and T3\n';

describe('spec files and the task graph', () => {
  it('reads tasks loosely: ids, requirements and dependencies', () => {
    const t = parseTasks(TASKS);
    expect(t.map((x) => [x.id, x.text, x.reqs, x.after, x.done])).toEqual([
      ['T1', 'Add the retry queue', ['R1'], [], false],
      ['T2', 'Backoff policy', ['R1', 'R2'], ['T1'], false],
      ['T3', 'Metrics for retries', ['R2'], ['T1'], false],
      ['T4', 'Docs', [], ['T2', 'T3'], true],
    ]);
    expect(readyTasks(t).map((x) => x.id)).toEqual(['T1']);
    expect(readyTasks(t.map((x) => (x.id === 'T1' ? {...x, done: true} : x))).map((x) => x.id)).toEqual(['T2', 'T3']);
    expect(graphProblems(parseTasks('- [ ] T1: a after: T2\n- [ ] T2: b after: T1\n- [ ] T3: c after: T9'))).toEqual(['T3 comes after T9, which isn\'t a task', 'cycle: T1 → T2 → T1']);
  });

  it('a new requirements draft un-approves the design and tasks written against the old one', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-spec-')));
    for (const s of ['requirements', 'design', 'tasks'] as const) writeFileSync(path.join(root, 'x'), ''), writeStage(root, 'retry', s, `<!-- approved 2026-01-01 -->\n# ${s} R1`);
    expect(nextStage(root, 'retry')).toBeUndefined();
    writeStage(root, 'retry', 'requirements', '# Retry\n\n- R1: retries');
    expect(readSpec(root, 'retry')!.stages).toEqual({requirements: {approved: false}, design: {approved: false}, tasks: {approved: false}});
  });
});

describe('spec mode', () => {
  it('approves stage by stage, then tracks tasks and traces their changes to requirements', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-spec-')));
    let active: string | undefined = 'retry';
    const asked: string[] = [];
    let answer = 'Approve';
    const [present, task] = specTools({
      active: () => active,
      root: () => root,
      ask: () => async (qs: AskQuestion[]) => (asked.push(qs[0]!.question), [{id: 'approve', selected: [answer]}]),
      approved: () => (active = undefined),
    });
    const ctx = {root} as any;
    await expect(present!.run(ctx, {stage: 'design', content: 'the design, long enough'})).rejects.toThrow(/requirements need approving first/);
    await expect(present!.run(ctx, {stage: 'requirements', content: 'no numbered requirements here'})).rejects.toThrow(/number the requirements/);
    answer = 'Revise';
    expect((await present!.run(ctx, {stage: 'requirements', content: '# Retry failed charges\n\n- R1: WHEN a charge fails THE SYSTEM SHALL retry it\n- R2: retries are counted'})).text).toMatch(/wants changes/);
    answer = 'Approve';
    expect((await present!.run(ctx, {stage: 'requirements', content: '# Retry failed charges\n\n- R1: WHEN a charge fails THE SYSTEM SHALL retry it\n- R2: retries are counted'})).text).toMatch(/approved the requirements.*write the design/);
    await present!.run(ctx, {stage: 'design', content: 'A queue in billing/retry.ts meets R1; a counter meets R2.'});
    await expect(present!.run(ctx, {stage: 'tasks', content: '- [ ] T1: queue (R7)'})).rejects.toThrow(/don't exist: R7/);
    const done = await present!.run(ctx, {stage: 'tasks', content: TASKS});
    expect(active).toBeUndefined();
    expect(done.text).toMatch(/Ready now.*\n- T1: Add the retry queue \(R1\)/);
    expect(asked).toHaveLength(4);
    expect(readFileSync(path.join(root, '.rein/specs/retry/tasks.md'), 'utf8')).toMatch(/^<!-- approved \d{4}-\d{2}-\d{2} -->\n# Tasks/);

    await expect(task!.run(ctx, {spec: 'retry', task: 'T2', action: 'start'})).rejects.toThrow(/comes after T1/);
    writeFileSync(path.join(root, 'charge.ts'), 'one\ntwo\n');
    await task!.run(ctx, {spec: 'retry', task: 'T1', action: 'start'});
    writeFileSync(path.join(root, 'charge.ts'), 'one\ntwo\nretry()\nqueue()\n');
    const r = await task!.run(ctx, {spec: 'retry', task: 't1', action: 'done'});
    expect(r.text).toMatch(/T1 done: 1 file traced to R1\.[\s\S]*Ready now[\s\S]*T2[\s\S]*T3[\s\S]*run them in parallel, one subagent each/);
    expect(readSpec(root, 'retry')!.tasks.find((t) => t.id === 'T1')!.done).toBe(true);
    expect(readFileSync(path.join(root, '.rein/specs/retry/trace.md'), 'utf8')).toContain('## R1\n\n- **T1** Add the retry queue\n  - `charge.ts`: 3-4\n\n## R2\n\nNothing traces to this requirement yet.');
  });
});

describe('specs in pull requests', () => {
  it('lists the specs and plans a branch changes for the reviewer', async () => {
    const {specSection} = await import('../src/specs/pr.js');
    expect(specSection(['.rein/specs/retry/requirements.md', '.rein/specs/retry/trace.md', '.rein/plans/2026-10-09-cache.md'])).toBe(
      '## Specs and plans\n- Spec `retry`: `.rein/specs/retry/` (requirements, design, tasks; `trace.md` links each requirement to the code)\n- Plan `.rein/plans/2026-10-09-cache.md`',
    );
  });
});
