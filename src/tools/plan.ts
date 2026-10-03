import path from 'node:path';
import {splitCommand} from './permissions.js';
import {ToolError} from './fs.js';
import {savePlan} from '../plans/store.js';
import type {ToolDef} from './registry.js';

/**
 * Plan mode (like Claude Code's): the agent explores read-only, then presents a plan for the user to
 * approve before anything changes. While it's on, file changes are refused and `shell` runs only
 * read-only commands.
 */
/** implement: carry it out now · goal: start a tracked goal from it · save: keep it for later · revise: keep planning. */
export type PlanDecision = 'implement' | 'goal' | 'save' | 'revise';

/** Programs that only read (whatever their arguments). */
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'tree', 'pwd', 'echo', 'printf', 'which', 'whereis', 'type', 'file', 'stat',
  'du', 'df', 'sort', 'uniq', 'cut', 'tr', 'column', 'jq', 'yq', 'env', 'printenv', 'date', 'cal', 'uname', 'whoami', 'id', 'groups', 'uptime',
  'basename', 'dirname', 'realpath', 'readlink', 'diff', 'cmp', 'comm', 'less', 'more', 'test', 'true', 'false', 'nl', 'fold', 'rev', 'tac', 'strings',
  'hexdump', 'xxd', 'od', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum', 'ps', 'pgrep', 'lsof', 'free', 'vm_stat', 'nproc', 'arch', 'locale',
  'sw_vers', 'system_profiler', 'mdls', 'mdfind', 'otool', 'nm', 'ldd', 'objdump', 'readelf', 'man', 'tldr', 'apropos', 'netstat', 'lsb_release',
]);
/** Programs whose listed subcommands (first argument) only read. */
const READ_ONLY_SUB: Record<string, Set<string>> = {
  git: new Set(['status', 'log', 'diff', 'show', 'branch', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'remote', 'describe', 'tag', 'shortlog', 'grep', 'config', 'cat-file', 'reflog', 'stash', 'worktree', 'show-ref', 'merge-base', 'name-rev']),
  npm: new Set(['ls', 'view', 'info', 'outdated', 'list', 'why', 'explain', 'config', 'help', 'search', 'root', 'prefix', 'bin', 'audit', 'doctor', 'pkg']),
  pnpm: new Set(['ls', 'list', 'why', 'outdated', 'root', 'audit']),
  yarn: new Set(['list', 'why', 'info', 'outdated', 'config']),
  brew: new Set(['list', 'ls', 'info', 'search', 'deps', 'uses', 'desc', 'config', 'outdated', 'leaves', 'doctor', '--prefix', '--cellar', '--repository', '--cache', '--env', 'tap-info', 'formulae', 'casks']),
  pip: new Set(['list', 'show', 'freeze', 'check', 'index', 'config']),
  pip3: new Set(['list', 'show', 'freeze', 'check', 'index', 'config']),
  cargo: new Set(['tree', 'metadata', 'search', 'locate-project', 'pkgid', 'read-manifest']),
  go: new Set(['version', 'env', 'list', 'doc']),
  docker: new Set(['ps', 'images', 'version', 'info', 'inspect', 'logs', 'history', 'top', 'stats', 'port', 'diff']),
  kubectl: new Set(['get', 'describe', 'logs', 'version', 'explain', 'top', 'api-resources', 'api-versions', 'cluster-info']),
  gh: new Set(['status']),
  defaults: new Set(['read', 'domains', 'find']),
  launchctl: new Set(['list', 'print']),
  diskutil: new Set(['list', 'info']),
  pmset: new Set(['-g']),
  'xcode-select': new Set(['-p', '--print-path']),
  xcrun: new Set(['--show-sdk-path', '--show-sdk-version', '--find', '-f']),
  sysctl: new Set(['-n', '-a', '-e']),
  dpkg: new Set(['-l', '-L', '-s', '--list', '--status']),
  rpm: new Set(['-q', '-qa', '-qi', '-ql']),
  apt: new Set(['list', 'show', 'search', 'policy']),
};
/** `<anything> --version` / `--help` (alone): reports, never changes. */
const INFO_FLAG = /^(--version|-version|-v|-V|version|--help|-h|help)$/;

/** Is this shell command safe while planning? Every part must be a read-only program, no writes via `>`. */
export function readOnlyCommand(command: string): boolean {
  const parts = splitCommand(command);
  if (!parts?.length) return false;
  return parts.every((p) => {
    if (/(^|[^0-9&])>(?!&)|>>/.test(p.replace(/2>&1|>\s*\/dev\/null/g, ''))) return false; // output redirection writes files
    const words = p.trim().split(/\s+/);
    const [prog = '', sub] = words;
    const name = path.basename(prog);
    if (READ_ONLY.has(name)) {
      // Read-only programs with writing (or command-running) options.
      if (name === 'env') return words.length === 1 || words.slice(1).every((w) => /^-/.test(w)); // `env cmd` runs cmd
      if (name === 'find' || name === 'fd') return !/\s-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls|x|X)\b|--exec/.test(p);
      if (name === 'sort') return !/\s(-o|--output)\b/.test(p);
      if (name === 'tree') return !/\s-o\b/.test(p);
      if (name === 'date') return !/\s(-s|--set)\b/.test(p);
      if (name === 'xxd') return !/\s-r\b/.test(p) && words.slice(1).filter((w) => !w.startsWith('-')).length <= 1;
      return true;
    }
    if (words.length === 2 && sub && INFO_FLAG.test(sub)) return true;
    if (!(sub && READ_ONLY_SUB[name]?.has(sub))) return false;
    // Subcommands that also have writing forms: only their reading forms.
    if (name === 'git' && sub === 'config') return /\s--(get|get-all|get-regexp|list|-l)\b|\s-l\b/.test(p);
    if (name === 'git' && sub === 'stash') return /^git\s+stash\s+(list|show)\b/.test(p.trim());
    if (name === 'git' && sub === 'worktree') return /^git\s+worktree\s+list\b/.test(p.trim());
    if (name === 'git' && sub === 'branch') return /\s(--list|-l)\b/.test(p) || words.slice(2).every((w) => /^(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--no-color|--color)$/.test(w));
    if (name === 'git' && sub === 'tag') return /\s(--list|-l)\b/.test(p) || words.slice(2).every((w) => /^(-n\d*|--sort=\S+|--points-at|--contains|--merged|--no-merged|HEAD|\S+\^\{\})$/.test(w) || /^[0-9a-f]{7,40}$/.test(w));
    if (name === 'git' && sub === 'remote') return words.length === 2 || /^(-v|--verbose|show|get-url)$/.test(words[2] ?? '');
    if (name === 'npm' && sub === 'config') return /\s(get|list|ls)\b/.test(p);
    if (name === 'npm' && sub === 'audit') return !/\sfix\b/.test(p);
    if (name === 'npm' && sub === 'pkg') return /\sget\b/.test(p);
    if (name === 'yarn' && sub === 'config') return /\s(get|list)\b/.test(p);
    if (name === 'pip' || name === 'pip3') return sub !== 'config' || /\s(list|get|debug)\b/.test(p);
    if (name === 'sysctl') return !/=/.test(p) && !/\s-w\b/.test(p);
    return true;
  });
}

export type PresentedPlan = {title: string; plan: string; milestones: string[]};

export function presentPlanTool(deps: {
  active(): boolean;
  /** Project root (plans are saved to <root>/.rein/plans/). */
  root(): string;
  present(plan: PresentedPlan): Promise<PlanDecision | undefined>;
  /** After a decision other than "revise": plan mode ends; "goal" starts a goal from the saved file. */
  done(decision: PlanDecision, file: string, title: string): void;
}): ToolDef {
  return {
    name: 'present_plan',
    label: 'Plan',
    description: 'Present your plan for approval.',
    describe: () =>
      'Only in plan mode (the user turns it on): present your finished plan to the user. Write it in markdown — the goal, the approach, the steps (files to change and how), risks and how you will verify — and list its milestones: 2–10 concrete, checkable outcomes in order (each one something you can prove done, e.g. "toolchain installed and `make` builds an empty kernel"). The user saves it and either has you carry it out now, starts it as a tracked goal, or saves it for later.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {type: 'string', description: 'Short title (a few words)'},
        plan: {type: 'string', description: 'The plan, in markdown'},
        milestones: {type: 'array', items: {type: 'string'}, description: 'Ordered, checkable milestones (2–10)'},
      },
      required: ['title', 'plan', 'milestones'],
    },
    mutating: false,
    mainOnly: true,
    summarize: (a) => String(a?.title ?? '') || (String(a?.plan ?? '').split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 80) ?? ''),
    async run(_ctx, args) {
      if (!deps.active()) throw new ToolError('plan mode is off — just do the work (no approval needed for the plan)');
      const plan = String(args?.plan ?? '').trim();
      if (plan.length < 20) throw new ToolError('write the plan out in full (goal, steps, verification)');
      const title = String(args?.title ?? '').trim() || plan.split('\n').find((l) => l.trim())!.replace(/^#+\s*/, '').slice(0, 60);
      const milestones = (Array.isArray(args?.milestones) ? args.milestones : []).map((m: unknown) => String(m).trim()).filter(Boolean);
      if (milestones.length < 1) throw new ToolError('list the milestones: 2–10 concrete, checkable outcomes in order');
      if (milestones.length > 12) throw new ToolError('at most 12 milestones — merge some');
      const decision = await deps.present({title, plan, milestones});
      if (decision === 'revise') return {ok: true, text: 'The user wants to refine the plan. Stop and wait for their feedback; stay in plan mode.'};
      const file = savePlan(deps.root(), {title, plan, milestones});
      if (!decision) return {ok: true, text: `Plan saved to ${file}. Nobody is here to approve it (headless run), so nothing will be changed — stop here.`};
      deps.done(decision, file, title);
      if (decision === 'save') return {ok: true, text: `Plan saved to ${file}; the user will start it later (/plan:goal). Plan mode is off. Don't start the work — briefly confirm it's saved and stop.`};
      if (decision === 'goal')
        return {
          ok: true,
          text: `Plan saved to ${file} and started as a goal. Plan mode is off. Work through the milestones in order: after each, call milestone_done with its number and concrete evidence; when all are done, call goal_done.`,
        };
      return {ok: true, text: `Plan saved to ${file}. The user approved it — plan mode is off; carry it out now, step by step (keep a todo_write task list).`};
    },
  };
}

/** Added to each message while plan mode is on, so the model knows the rules. */
export const PLAN_MODE_CONTEXT =
  'PLAN MODE is on: do not change anything yet. Explore with read-only tools (read, list, search, web, read-only shell commands, subagents) until you understand the task, then call present_plan with a concrete plan. File changes and other commands are blocked until the user approves.';
