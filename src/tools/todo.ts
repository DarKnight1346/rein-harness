import type {Transcript} from '../session/transcript.js';
import {ToolError} from './fs.js';
import type {ToolDef} from './registry.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = {content: string; status: TodoStatus; activeForm?: string};

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MARK: Record<TodoStatus, string> = {pending: '☐', in_progress: '◐', completed: '☑'};

export const todoLine = (t: Todo) => `${MARK[t.status]} ${t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}`;

/**
 * `todo_write` (main agent): the task list for multi-step work, like Claude Code's TodoWrite. Each
 * call replaces the whole list; it's saved with the conversation and shown in the sidebar.
 */
export function todoTool(deps: {transcript(): Transcript | undefined; changed(): void}): ToolDef {
  return {
    name: 'todo_write',
    label: 'Tasks',
    description: 'Write the task list.',
    describe: () =>
      [
        'Keep a task list for multi-step work (3+ steps, or when the user gives several things to do). Each call replaces the whole list; the user sees it in the sidebar.',
        '- Statuses: pending, in_progress, completed. Keep exactly one task in_progress while working; mark each completed as soon as it is done (don\'t batch).',
        '- content: imperative ("Run the tests"); activeForm: present continuous shown while in progress ("Running the tests").',
        '- Skip it for single, trivial requests.',
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
      const note = active > 1 ? '\nNote: keep only one task in_progress at a time.' : todos.length && !active && todos.some((x) => x.status === 'pending') ? '\nNote: mark the task you are working on in_progress.' : '';
      return {ok: true, text: `Task list updated:\n${todos.map(todoLine).join('\n') || '(empty)'}${note}`};
    },
  };
}
