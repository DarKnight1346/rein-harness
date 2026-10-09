import {ToolError} from '../tools/fs.js';
import type {AskAnswer, AskQuestion} from '../tools/ask.js';
import type {ToolDef} from '../tools/registry.js';
import {approveStage, graphProblems, nextStage, parseTasks, readSpec, readStage, readyTasks, setTaskDone, STAGES, type Stage, type Task, writeStage} from './store.js';
import {recordTrace, startTask, taskChanges} from './trace.js';

/** Spec mode (/spec): requirements, then design, then tasks, each approved by the user before the next. */
export const SPEC_MODE_CONTEXT = (name: string) =>
  `SPEC MODE is on for spec "${name}" (.rein/specs/${name}/): don't change any code yet. Write the next stage and call present_spec; the user approves each stage before the next. File changes are blocked until the tasks are approved.`;

export function specInstructions(name: string, ask: string): string {
  return [
    `Write a spec for this, in three stages the user approves one at a time (spec "${name}", saved in .rein/specs/${name}/):`,
    '',
    ask,
    '',
    '1. **requirements**: explore the code read-only first. Then a `# Title`, a short context paragraph, and numbered requirements R1, R2, … each with testable acceptance criteria ("WHEN … THE SYSTEM SHALL …" works well). Ask with ask_user what you can\'t infer.',
    '2. **design**: the approach, components and files involved, data and interfaces, error handling, and how each requirement is met (cite R ids). Note risks.',
    '3. **tasks**: a checklist, one line per task: `- [ ] T1: what to do (R1, R2) after: —`. Name the requirements each task meets and the tasks it must come after (`after: T1, T3`); tasks without a dependency between them can run in parallel. Keep each task small enough to verify.',
    '',
    'Call present_spec with each stage when it\'s ready; revise and present again if the user asks.',
  ].join('\n');
}

type Deps = {
  /** The spec being written in spec mode, or undefined. */
  active(): string | undefined;
  root(): string;
  ask(): ((qs: AskQuestion[]) => Promise<AskAnswer[] | undefined>) | undefined;
  /** The tasks were approved: spec mode ends. */
  approved(name: string): void;
};

/** What runs next: the ready tasks, and how to run independent ones at once. */
export function nextSteps(name: string, tasks: Task[]): string {
  const ready = readyTasks(tasks);
  const left = tasks.filter((t) => !t.done).length;
  if (!left) return `Every task of spec "${name}" is done. Check the requirements' acceptance criteria hold, then summarize for the user (.rein/specs/${name}/trace.md links each requirement to the code).`;
  const list = ready.map((t) => `- ${t.id}: ${t.text}${t.reqs.length ? ` (${t.reqs.join(', ')})` : ''}`).join('\n');
  return [
    `${left} task${left === 1 ? '' : 's'} left. Ready now (everything they come after is done):`,
    list,
    ready.length > 1
      ? `These don't depend on each other: run them in parallel, one subagent each (the agent tool, with their own worktrees), telling each subagent to call spec_task start before and spec_task done after its task (spec "${name}").`
      : `Call spec_task start for it, do it, then spec_task done.`,
  ].join('\n');
}

export function specTools(deps: Deps): ToolDef[] {
  return [
    {
      name: 'present_spec',
      label: 'Spec',
      description: 'Present a stage of the spec for approval.',
      describe: () =>
        'Only in spec mode (/spec): save a stage of the spec (requirements, then design, then tasks) and ask the user to approve it. Each stage needs the one before approved. Requirements are numbered R1, R2…; tasks are a checklist `- [ ] T1: … (R1) after: T2`.',
      inputSchema: {
        type: 'object',
        properties: {
          stage: {type: 'string', enum: [...STAGES], description: 'Which stage this is'},
          content: {type: 'string', description: 'The stage, in markdown'},
        },
        required: ['stage', 'content'],
      },
      mutating: false,
      mainOnly: true,
      summarize: (a) => `${deps.active() ?? ''} ${a?.stage ?? ''}`.trim(),
      async run(_ctx, args) {
        const name = deps.active();
        if (!name) throw new ToolError('spec mode is off: /spec starts it');
        const stage = String(args?.stage ?? '') as Stage;
        if (!STAGES.includes(stage)) throw new ToolError('stage must be requirements, design or tasks');
        const content = String(args?.content ?? '').trim();
        if (content.length < 20) throw new ToolError(`write the ${stage} out in full`);
        const root = deps.root();
        const next = nextStage(root, name) ?? 'tasks';
        if (STAGES.indexOf(stage) > STAGES.indexOf(next)) throw new ToolError(`the ${next} need approving first: present them`);
        if (stage === 'requirements' && !/\bR1\b/.test(content)) throw new ToolError('number the requirements R1, R2, … so design and tasks can refer to them');
        if (stage === 'tasks') {
          const tasks = parseTasks(content);
          if (!tasks.length) throw new ToolError('no tasks found: one per line, `- [ ] T1: what to do (R1) after: —`');
          const problems = graphProblems(tasks);
          if (problems.length) throw new ToolError(`fix the task graph: ${problems.join('; ')}`);
          const reqs = new Set(readStage(root, name, 'requirements')?.text.match(/\bR\d+(?:\.\d+)?\b/g) ?? []);
          const unknown = [...new Set(tasks.flatMap((t) => t.reqs).filter((r) => !reqs.has(r)))];
          if (unknown.length) throw new ToolError(`tasks name requirements that don't exist: ${unknown.join(', ')}`);
        }
        const file = writeStage(root, name, stage, content);
        const ask = deps.ask();
        if (!ask) return {ok: true, text: `Saved ${file}. Nobody is here to approve it (headless run): stop here.`};
        const answers = await ask([{id: 'approve', question: `Approve the ${stage} of spec "${name}"? (${file})`, options: [{label: 'Approve'}, {label: 'Revise', description: 'Say what to change'}], multi: false}]);
        const a = answers?.[0];
        if (!a?.selected.includes('Approve')) return {ok: true, text: `The user wants changes to the ${stage}${a?.other ? `: ${a.other}` : a?.selected.length ? '' : ' (no answer)'}. Revise it and present it again, or wait for their feedback.`};
        approveStage(root, name, stage);
        if (stage !== 'tasks') return {ok: true, text: `The user approved the ${stage} (${file}). Now write the ${STAGES[STAGES.indexOf(stage) + 1]} and present them.`};
        deps.approved(name);
        return {ok: true, text: `The user approved the tasks. Spec mode is off: carry them out.\n${nextSteps(name, parseTasks(content))}`};
      },
    },
    {
      name: 'spec_task',
      label: 'SpecTask',
      description: 'Start or finish a task of a spec.',
      describe: () =>
        "Track a spec's tasks (.rein/specs/<spec>/tasks.md): `start` before working on a task, `done` when it's finished and verified. Done ticks its box and records the lines changed since start against its requirements (trace.md), then says which tasks are ready next.",
      inputSchema: {
        type: 'object',
        properties: {
          spec: {type: 'string', description: 'The spec name (its folder in .rein/specs/)'},
          task: {type: 'string', description: 'The task id, e.g. T3'},
          action: {type: 'string', enum: ['start', 'done']},
        },
        required: ['spec', 'task', 'action'],
      },
      mutating: false,
      summarize: (a) => `${a?.spec ?? ''} ${a?.task ?? ''} ${a?.action ?? ''}`.trim(),
      async run(ctx, args) {
        const root = deps.root();
        const name = String(args?.spec ?? '');
        const spec = readSpec(root, name);
        if (!spec) throw new ToolError(`no spec "${name}" in .rein/specs/`);
        if (!spec.stages.tasks?.approved) throw new ToolError(`the tasks of ${name} aren't approved yet`);
        const id = String(args?.task ?? '').toUpperCase();
        const task = spec.tasks.find((t) => t.id === id);
        if (!task) throw new ToolError(`${name} has no task ${id}`);
        if (args?.action === 'start') {
          const blocked = task.after.filter((a) => spec.tasks.find((t) => t.id === a && !t.done));
          if (blocked.length) throw new ToolError(`${id} comes after ${blocked.join(', ')}, not done yet`);
          await startTask(ctx.root, name, id).catch(() => {});
          return {ok: true, text: `Started ${id}: ${task.text}${task.reqs.length ? ` (meets ${task.reqs.join(', ')})` : ''}.`};
        }
        if (args?.action !== 'done') throw new ToolError('action must be start or done');
        const files = await taskChanges(ctx.root, name, id).catch(() => undefined);
        setTaskDone(root, name, id, true);
        recordTrace(root, name, task, files ?? []);
        const after = readSpec(root, name)!;
        const changed = files?.length ? `${files.length} file${files.length === 1 ? '' : 's'} traced to ${task.reqs.join(', ') || 'it'}` : 'no changes recorded (call spec_task start before a task to trace it)';
        return {ok: true, text: `${id} done: ${changed}.\n${nextSteps(name, after.tasks)}`};
      },
    },
  ];
}
