import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {splitCommand} from './permissions.js';
import {ToolError} from './fs.js';
import type {ToolDef} from './registry.js';

/**
 * Plan mode (like Claude Code's): the agent explores read-only, then presents a plan for the user to
 * approve before anything changes. While it's on, file changes are refused and `shell` runs only
 * read-only commands.
 */
export type PlanDecision = 'approve' | 'approve-all' | 'revise';

/** Programs (and git/npm subcommands) that only read. Anything else waits for the plan's approval. */
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'tree', 'pwd', 'echo', 'which', 'file', 'stat', 'du', 'df', 'sort', 'uniq', 'cut', 'jq', 'env', 'printenv', 'date', 'uname', 'whoami', 'basename', 'dirname', 'realpath', 'diff', 'less', 'more', 'test', 'true']);
const READ_ONLY_SUB: Record<string, Set<string>> = {
  git: new Set(['status', 'log', 'diff', 'show', 'branch', 'blame', 'ls-files', 'rev-parse', 'remote', 'describe', 'tag', 'shortlog', 'grep', 'config']),
  npm: new Set(['ls', 'view', 'outdated', 'list', 'why', 'config', 'help']),
  pnpm: new Set(['ls', 'list', 'why', 'outdated']),
  yarn: new Set(['list', 'why', 'info', 'outdated']),
  node: new Set(['--version', '-v']),
  python: new Set(['--version', '-V']),
  python3: new Set(['--version', '-V']),
};

/** Is this shell command safe while planning? Every part must be a read-only program, no writes via `>`. */
export function readOnlyCommand(command: string): boolean {
  const parts = splitCommand(command);
  if (!parts?.length) return false;
  return parts.every((p) => {
    if (/(^|[^0-9&])>(?!&)|>>/.test(p.replace(/2>&1|>\s*\/dev\/null/g, ''))) return false; // output redirection writes files
    const [prog = '', sub] = p.trim().split(/\s+/);
    const name = path.basename(prog);
    if (READ_ONLY.has(name)) return !(name === 'find' && /\s-(delete|exec|ok)\b/.test(p));
    return !!(sub && READ_ONLY_SUB[name]?.has(sub)) && !(name === 'git' && sub === 'config' && !/\s--(get|list)/.test(p));
  });
}

export function presentPlanTool(deps: {
  active(): boolean;
  scratch(): string | undefined;
  present(plan: string): Promise<PlanDecision | undefined>;
  done(decision: PlanDecision): void;
}): ToolDef {
  return {
    name: 'present_plan',
    label: 'Plan',
    description: 'Present your plan for approval.',
    describe: () =>
      'Only in plan mode (the user turns it on): present your finished plan to the user for approval. Write it in markdown — the goal, the steps (files to change and how), risks and how you will verify. If approved, plan mode ends and you carry it out; otherwise wait for the user\'s feedback.',

    inputSchema: {type: 'object', properties: {plan: {type: 'string', description: 'The plan, in markdown'}}, required: ['plan']},
    mutating: false,
    mainOnly: true,
    summarize: (a) => String(a?.plan ?? '').split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 80) ?? '',
    async run(_ctx, args) {
      if (!deps.active()) throw new ToolError('plan mode is off — just do the work (no approval needed for the plan)');
      const plan = String(args?.plan ?? '').trim();
      if (plan.length < 20) throw new ToolError('write the plan out in full (goal, steps, verification)');
      const scratch = deps.scratch();
      let saved = '';
      if (scratch) {
        const file = path.join(scratch, 'plans', `plan-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
        mkdirSync(path.dirname(file), {recursive: true});
        writeFileSync(file, plan + '\n');
        saved = ` (saved to ${file})`;
      }
      const decision = await deps.present(plan);
      if (!decision) return {ok: true, text: `Plan presented${saved}. Nobody is here to approve it (headless run), so nothing will be changed — stop here.`};
      deps.done(decision);
      if (decision === 'revise') return {ok: true, text: `The user wants to refine the plan${saved}. Stop and wait for their feedback; stay in plan mode.`};
      return {ok: true, text: `The user approved the plan${saved}${decision === 'approve-all' ? ' and allowed all changes for this session' : ''}. Plan mode is off — carry it out now, step by step.`};
    },
  };
}

/** Added to each message while plan mode is on, so the model knows the rules. */
export const PLAN_MODE_CONTEXT =
  'PLAN MODE is on: do not change anything yet. Explore with read-only tools (read, list, search, web, read-only shell commands, subagents) until you understand the task, then call present_plan with a concrete plan. File changes and other commands are blocked until the user approves.';
