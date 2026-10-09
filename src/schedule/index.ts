import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {reinHome} from '../store/paths.js';
import {run} from '../util/proc.js';

/**
 * Scheduled jobs: recurring local runs defined in a project's `.rein/schedule.yaml` (a cron
 * expression and a prompt each). `rein schedule run --due` runs the jobs whose time has come, each
 * as its own headless `rein -p` in its project, with the output kept in a log. `rein schedule
 * install` asks the OS scheduler (crontab, or Task Scheduler on Windows) to call that every 15
 * minutes; nothing is installed until you run it.
 */
export type Job = {name: string; cron: string; prompt: string; model?: string; permissionMode: 'ask' | 'auto' | 'bypass'; project: string};
export type JobState = {lastRun?: number; lastExit?: number; lastLog?: string};

export const scheduleFile = (root: string) => path.join(root, '.rein', 'schedule.yaml');
const stateDir = () => path.join(reinHome(), 'schedule');
const stateFile = () => path.join(stateDir(), 'state.json');
const projectsFile = () => path.join(stateDir(), 'projects.json');

const ALIASES: Record<string, string> = {'@hourly': '0 * * * *', '@daily': '0 9 * * *', '@weekdays': '0 9 * * 1-5', '@weekly': '0 9 * * 1', '@monthly': '0 9 1 * *'};

/** A cron field as the set of values it matches. */
function field(spec: string, min: number, max: number, names: string[] = []): Set<number> | undefined {
  const out = new Set<number>();
  for (const part of spec.toLowerCase().split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) return undefined;
    const val = (s: string) => {
      const i = names.indexOf(s.slice(0, 3));
      return i >= 0 ? i + min : Number(s);
    };
    let lo: number;
    let hi: number;
    if (range === '*') [lo, hi] = [min, max];
    else if (range!.includes('-')) [lo, hi] = range!.split('-').map(val) as [number, number];
    else [lo, hi] = [val(range!), stepS === undefined ? val(range!) : max];
    if (![lo, hi].every((n) => Number.isInteger(n) && n >= min && n <= max) || lo > hi) return undefined;
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

export type Cron = {minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number>; anyDay: boolean; anyWeekday: boolean};

/** Five-field cron (minute hour day month weekday), names like mon/jan, ranges, lists, steps, and @daily-style aliases. */
export function parseCron(expr: string): Cron | undefined {
  const parts = (ALIASES[expr.trim()] ?? expr).trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [mi, h, d, mo, w] = parts as [string, string, string, string, string];
  const minute = field(mi, 0, 59);
  const hour = field(h, 0, 23);
  const day = field(d, 1, 31);
  const month = field(mo, 1, 12, ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
  const weekday = field(w.replace(/\b7\b/, '0'), 0, 6, ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  if (!minute || !hour || !day || !month || !weekday) return undefined;
  return {minute, hour, day, month, weekday, anyDay: d === '*', anyWeekday: w === '*'};
}

function matches(c: Cron, t: Date): boolean {
  if (!c.minute.has(t.getMinutes()) || !c.hour.has(t.getHours()) || !c.month.has(t.getMonth() + 1)) return false;
  // Cron's rule: when both day fields are restricted, either may match.
  const d = c.day.has(t.getDate());
  const w = c.weekday.has(t.getDay());
  return c.anyDay && c.anyWeekday ? true : c.anyDay ? w : c.anyWeekday ? d : d || w;
}

/** The first minute after `after` that the cron matches (local time), within a year. */
export function nextRun(c: Cron, after: number): number | undefined {
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(c, t)) return t.getTime();
    t.setMinutes(t.getMinutes() + 1);
  }
  return undefined;
}

export function loadJobs(root: string): {jobs: Job[]; errors: string[]} {
  let text: string;
  try {
    text = readFileSync(scheduleFile(root), 'utf8');
  } catch {
    return {jobs: [], errors: []};
  }
  const errors: string[] = [];
  let doc: any;
  try {
    doc = parseYaml(text) ?? {};
  } catch (err) {
    return {jobs: [], errors: [`.rein/schedule.yaml: ${(err as Error).message.split('\n')[0]}`]};
  }
  const list = Array.isArray(doc.jobs) ? doc.jobs : doc.jobs && typeof doc.jobs === 'object' ? Object.entries(doc.jobs).map(([name, v]) => ({name, ...(v as object)})) : [];
  const jobs: Job[] = [];
  for (const [i, j] of list.entries()) {
    const name = String(j?.name ?? '').trim();
    const cron = String(j?.cron ?? j?.every ?? '').trim();
    const prompt = String(j?.prompt ?? '').trim();
    if (!name || !prompt) errors.push(`jobs[${i}]: needs a name and a prompt`);
    else if (!parseCron(cron)) errors.push(`${name}: "${cron}" isn't a cron expression (minute hour day month weekday, or @daily, @weekly…)`);
    else if (j.permissionMode && !['ask', 'auto', 'bypass'].includes(j.permissionMode)) errors.push(`${name}: permissionMode must be ask, auto or bypass`);
    else jobs.push({name, cron, prompt, ...(j.model ? {model: String(j.model)} : {}), permissionMode: j.permissionMode ?? 'auto', project: path.resolve(root)});
  }
  return {jobs, errors};
}

function readJson<T>(f: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
const key = (j: Job) => `${j.project}|${j.name}`;
export const jobState = (j: Job): JobState => readJson<Record<string, JobState>>(stateFile(), {})[key(j)] ?? {};
function saveState(j: Job, s: JobState): void {
  const all = readJson<Record<string, JobState>>(stateFile(), {});
  all[key(j)] = s;
  mkdirSync(stateDir(), {recursive: true});
  writeFileSync(stateFile(), JSON.stringify(all, null, 2));
}

/** Projects whose schedules `rein schedule run --due` covers (added by `rein schedule install`). */
export const scheduledProjects = (): string[] => readJson<string[]>(projectsFile(), []);
export function addProject(root: string): void {
  const all = new Set(scheduledProjects());
  all.add(path.resolve(root));
  mkdirSync(stateDir(), {recursive: true});
  writeFileSync(projectsFile(), JSON.stringify([...all], null, 2));
}
export function removeProject(root: string): string[] {
  const left = scheduledProjects().filter((p) => p !== path.resolve(root));
  mkdirSync(stateDir(), {recursive: true});
  writeFileSync(projectsFile(), JSON.stringify(left, null, 2));
  return left;
}

/** Due: a scheduled time passed since the last run (or since it was first seen, so a new job waits for its first time). */
export function isDue(j: Job, now: number, state = jobState(j)): boolean {
  const c = parseCron(j.cron)!;
  const from = state.lastRun ?? now - 15 * 60_000; // never run: only a time within the last 15 minutes counts
  const next = nextRun(c, from);
  return next !== undefined && next <= now;
}

export type Spawner = (args: string[], cwd: string, log: string) => Promise<number>;

/** Runs a job as `rein -p` in its project; its output goes to a log file. */
const defaultSpawner: Spawner = (args, cwd, log) =>
  new Promise((resolve) => {
    mkdirSync(path.dirname(log), {recursive: true});
    const chunks: Buffer[] = [];
    const p = spawn(process.execPath, [process.argv[1]!, ...args], {cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => chunks.push(d));
    p.on('error', (err) => chunks.push(Buffer.from(String(err))));
    p.on('close', (code) => {
      writeFileSync(log, Buffer.concat(chunks));
      resolve(code ?? 1);
    });
  });

export async function runJob(j: Job, spawner: Spawner = defaultSpawner, now = Date.now()): Promise<JobState> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const log = path.join(stateDir(), 'logs', `${j.name.replace(/[^\w.-]+/g, '-')}-${stamp}.log`);
  saveState(j, {...jobState(j), lastRun: now}); // a long job isn't started twice
  const args = ['-p', `${j.prompt}\n\n(This is the scheduled job "${j.name}": nobody is watching, so finish on your own and end with a short summary of what you did.)`, '--permission-mode', j.permissionMode, ...(j.model ? ['--model', j.model] : [])];
  const exit = await spawner(args, j.project, log);
  const state = {lastRun: now, lastExit: exit, lastLog: log};
  saveState(j, state);
  return state;
}

/** `rein schedule run --due`: every due job in every scheduled project (and this one). */
export async function runDue(cwd: string, spawner?: Spawner, now = Date.now()): Promise<{job: Job; state: JobState}[]> {
  const out: {job: Job; state: JobState}[] = [];
  for (const project of [...new Set([...scheduledProjects(), path.resolve(cwd)])]) for (const j of loadJobs(project).jobs) if (isDue(j, now)) out.push({job: j, state: await runJob(j, spawner, now)});
  return out;
}

export function describeJobs(jobs: Job[], now = Date.now()): string {
  return jobs
    .map((j) => {
      const s = jobState(j);
      const next = nextRun(parseCron(j.cron)!, now);
      return `  ${j.name}  ${j.cron}  next ${next ? new Date(next).toLocaleString() : '—'}${s.lastRun ? ` · last ${new Date(s.lastRun).toLocaleString()} (${s.lastExit === 0 ? 'ok' : s.lastExit === undefined ? 'running' : `exit ${s.lastExit}`})` : ' · never run'}`;
    })
    .join('\n');
}

const CRON_TAG = '# rein schedule';
export type Exec = (cmd: string, args: string[], input?: string) => Promise<{code: number; stdout: string}>;
const defaultExec: Exec = async (cmd, args, input) => {
  if (input === undefined) {
    const r = await run(cmd, args, {timeoutMs: 20_000}).catch(() => ({code: 1, stdout: ''}));
    return {code: r.code ?? 1, stdout: r.stdout};
  }
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {stdio: ['pipe', 'pipe', 'ignore']});
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('error', () => resolve({code: 1, stdout}));
    p.on('close', (code) => resolve({code: code ?? 1, stdout}));
    p.stdin.end(input);
  });
};

/** The command the OS scheduler runs every 15 minutes. */
export const scheduledCommand = () => `"${process.execPath}" "${process.argv[1]}" schedule run --due`;

/** `rein schedule install`: register the project and add the OS scheduler entry (once for all projects). */
export async function install(root: string, exec: Exec = defaultExec, platform = process.platform): Promise<string> {
  addProject(root);
  if (platform === 'win32') {
    const r = await exec('schtasks', ['/Create', '/F', '/SC', 'MINUTE', '/MO', '15', '/TN', 'Rein schedule', '/TR', scheduledCommand()]);
    return r.code === 0 ? 'Added the Task Scheduler task "Rein schedule" (every 15 minutes).' : 'Couldn’t add the Task Scheduler task (schtasks failed).';
  }
  const current = (await exec('crontab', ['-l'])).stdout;
  if (current.includes(CRON_TAG)) return 'The crontab entry is already there; this project is now scheduled too.';
  const line = `*/15 * * * * ${scheduledCommand()} >/dev/null 2>&1 ${CRON_TAG}`;
  const r = await exec('crontab', ['-'], `${current.trimEnd()}${current.trim() ? '\n' : ''}${line}\n`);
  return r.code === 0 ? 'Added a crontab entry that runs due jobs every 15 minutes.' : 'Couldn’t update your crontab (crontab - failed).';
}

/** `rein schedule uninstall`: unregister the project; remove the OS entry when no project is left. */
export async function uninstall(root: string, exec: Exec = defaultExec, platform = process.platform): Promise<string> {
  if (removeProject(root).length) return 'This project’s jobs won’t run any more (other projects still have schedules).';
  if (platform === 'win32') {
    await exec('schtasks', ['/Delete', '/F', '/TN', 'Rein schedule']);
    return 'Removed the Task Scheduler task.';
  }
  const current = (await exec('crontab', ['-l'])).stdout;
  await exec('crontab', ['-'], current.split('\n').filter((l) => !l.includes(CRON_TAG)).join('\n'));
  return 'Removed the crontab entry.';
}
