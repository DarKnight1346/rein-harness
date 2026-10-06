import type {Transcript} from '../session/transcript.js';
import {ToolError} from './fs.js';
import type {ToolDef} from './registry.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = {content: string; status: TodoStatus; activeForm?: string};

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MARK: Record<TodoStatus, string> = {pending: '☐', in_progress: '◐', completed: '☑'};

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'it', 'is', 'be', 'that', 'this', 'all', 'up']);
const words = (s: string) => new Set(s.toLowerCase().replace(/[`'"*_]/g, '').split(/[^a-z0-9.]+/).filter((w) => w && !STOP.has(w)));

/**
 * A task that restates a plan milestone. Agents (Claude especially) copy a goal's milestones into
 * todo_write and then tick only the milestones, so the copies would sit in the sidebar undone.
 */
export function sameTask(task: string, milestone: string): boolean {
  const a = words(task);
  const b = words(milestone.replace(/^\s*\d+[.)]\s*/, ''));
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size) >= 0.75 || shared / Math.max(a.size, b.size) >= 0.6;
}

export const isMilestoneCopy = (t: Todo, milestones: string[]) => milestones.some((m) => sameTask(t.content, m) || (!!t.activeForm && sameTask(t.activeForm, m)));

export const todoLine = (t: Todo) => `${MARK[t.status]} ${t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}`;

/**
 * `todo_write` (main agent): the task list for multi-step work, like Claude Code's TodoWrite. Each
 * call replaces the whole list; it's saved with the conversation and shown in the sidebar.
 */
export function todoTool(deps: {transcript(): Transcript | undefined; changed(): void; milestones?(): string[] | undefined}): ToolDef {
  return {
    name: 'todo_write',
    label: 'Tasks',
    description: 'Write the task list.',
    describe: () =>
      [
        'Keep a task list for multi-step work (3+ steps, or when the user gives several things to do). Each call replaces the whole list; the user sees it in the sidebar.',
        '- Statuses: pending, in_progress, completed. Keep exactly one task in_progress while working; mark tasks completed as they finish (several in one call is fine: each call is a round trip).',
        '- content: imperative ("Run the tests"); activeForm: present continuous shown while in progress ("Running the tests").',
        '- Skip it for single, trivial requests.',
        "- While a goal works from a plan, its milestones are the task list (the user sees them): use this only for sub-steps of the current milestone, never to copy the milestones.",
      ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: {type: 'string'},
              status: {type: 'string', enum: STATUSES},
              activeForm: {type: 'string'},
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    mutating: false,
    mainOnly: true,
    summarize: (a) => {
      const list: Todo[] = Array.isArray(a?.todos) ? a.todos : [];
      const done = list.filter((t) => t.status === 'completed').length;
      return `${done}/${list.length} done`;
    },
    async run(_ctx, args) {
      if (!Array.isArray(args?.todos)) throw new ToolError('todos must be an array');
      const todos: Todo[] = args.todos.map((t: any, i: number) => {
        if (typeof t?.content !== 'string' || !t.content.trim()) throw new ToolError(`todo #${i + 1} needs content`);
        if (!STATUSES.includes(t.status)) throw new ToolError(`todo #${i + 1}: status must be pending, in_progress or completed`);
        return {content: t.content.trim(), status: t.status, ...(typeof t.activeForm === 'string' && t.activeForm.trim() ? {activeForm: t.activeForm.trim()} : {})};
      });
      const t = deps.transcript();
      if (t) t.todos = todos;
      deps.changed();
      const active = todos.filter((x) => x.status === 'in_progress').length;
      const milestones = deps.milestones?.() ?? [];
      const copies = milestones.length ? todos.filter((x) => isMilestoneCopy(x, milestones)).length : 0;
      const note = copies
        ? `\nNote: ${copies} of these repeat the plan's milestones, which already track progress (milestone_done ticks them, and the sidebar hides the copies). Use the task list only for sub-steps of the current milestone.`
        : active > 1 ? '\nNote: keep only one task in_progress at a time.' : todos.length && !active && todos.some((x) => x.status === 'pending') ? '\nNote: mark the task you are working on in_progress.' : '';
      return {ok: true, text: `Task list updated:\n${todos.map(todoLine).join('\n') || '(empty)'}${note}`};
    },
  };
}
