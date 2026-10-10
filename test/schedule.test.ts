import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {install, isDue, loadJobs, nextRun, parseCron, runDue, runJob, scheduledProjects, uninstall, type Exec} from '../src/schedule/index.js';

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

const at = (s: string) => new Date(s).getTime(); // local time
function project(yaml: string) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-sch-')));
  mkdirSync(path.join(root, '.rein'));
  writeFileSync(path.join(root, '.rein/schedule.yaml'), yaml);
  return root;
}

describe('cron', () => {
  it('parses fields, names, ranges, steps and aliases, and finds the next time', () => {
    expect(parseCron('nope')).toBeUndefined();
    expect(parseCron('61 * * * *')).toBeUndefined();
    const weekdays = parseCron('30 9 * * mon-fri')!;
    expect(new Date(nextRun(weekdays, at('2026-10-09T10:00:00'))!).toString()).toBe(new Date('2026-10-12T09:30:00').toString()); // Friday 10:00 → Monday 9:30
    expect(nextRun(parseCron('*/15 * * * *')!, at('2026-10-09T10:07:00'))).toBe(at('2026-10-09T10:15:00'));
    expect(nextRun(parseCron('@weekly')!, at('2026-10-09T10:00:00'))).toBe(at('2026-10-12T09:00:00'));
    expect(nextRun(parseCron('0 0 1,15 * *')!, at('2026-10-09T10:00:00'))).toBe(at('2026-10-15T00:00:00'));
  });
});

describe('scheduled jobs', () => {
  it('reads jobs and reports bad ones', () => {
    const root = project('jobs:\n  - name: deps\n    cron: "0 9 * * mon"\n    prompt: Bump patch versions, run the tests, open a PR if green\n  - name: bad\n    cron: every tuesday\n    prompt: x\n  - name: flaky\n    cron: "@daily"\n    prompt: Triage flaky tests\n    model: claude:sonnet\n    permissionMode: bypass\n');
    const {jobs, errors} = loadJobs(root);
    expect(jobs.map((j) => [j.name, j.cron, j.model, j.permissionMode])).toEqual([['deps', '0 9 * * mon', undefined, 'auto'], ['flaky', '@daily', 'claude:sonnet', 'bypass']]);
    expect(errors).toEqual(['bad: "every tuesday" isn\'t a cron expression (minute hour day month weekday, or @daily, @weekly…)']);
  });

  it('runs due jobs once per scheduled time, as rein -p in the project', async () => {
    const root = project('jobs:\n  - name: deps\n    cron: "0 9 * * *"\n    prompt: Bump dependencies\n    model: codex:gpt-5.5\n');
    const job = loadJobs(root).jobs[0]!;
    expect(isDue(job, at('2026-10-09T08:59:00'))).toBe(false);
    expect(isDue(job, at('2026-10-09T09:05:00'))).toBe(true);
    const calls: {args: string[]; cwd: string}[] = [];
    const spawner = async (args: string[], cwd: string) => (calls.push({args, cwd}), 0);
    const ran = await runDue(root, spawner, at('2026-10-09T09:05:00'));
    expect(ran.map((r) => [r.job.name, r.state.lastExit])).toEqual([['deps', 0]]);
    expect(calls[0]!.cwd).toBe(root);
    expect(calls[0]!.args).toEqual(['-p', expect.stringMatching(/^Bump dependencies\n\n\(This is the scheduled job "deps": nobody is watching/), '--permission-mode', 'auto', '--model', 'codex:gpt-5.5']);
    expect(await runDue(root, spawner, at('2026-10-09T09:20:00'))).toEqual([]); // already ran for 9:00
    expect((await runDue(root, spawner, at('2026-10-10T09:01:00'))).length).toBe(1); // the next day
    expect((await runJob(job, async () => 3, at('2026-10-10T12:00:00'))).lastExit).toBe(3);
  });

  it('installs one OS entry for every project and removes it with the last one', async () => {
    const a = project('jobs: []\n');
    const b = project('jobs: []\n');
    let crontab = 'MAILTO=me\n0 1 * * * backup\n';
    const calls: string[] = [];
    const exec: Exec = async (cmd, args, input) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'crontab' && args[0] === '-l') return {code: 0, stdout: crontab};
      if (cmd === 'crontab' && args[0] === '-') crontab = input!;
      return {code: 0, stdout: ''};
    };
    expect(await install(a, exec, 'linux')).toBe('Added a crontab entry that runs due jobs every 15 minutes.');
    expect(crontab).toMatch(/^MAILTO=me\n0 1 \* \* \* backup\n\*\/15 \* \* \* \* ".*" ".*" schedule run --due >\/dev\/null 2>&1 # rein schedule\n$/);
    expect(await install(b, exec, 'linux')).toMatch(/already there/);
    expect(scheduledProjects()).toEqual([a, b]);
    expect(await uninstall(a, exec, 'linux')).toMatch(/other projects still have schedules/);
    expect(await uninstall(b, exec, 'linux')).toBe('Removed the crontab entry.');
    expect(crontab).toBe('MAILTO=me\n0 1 * * * backup\n');
    calls.length = 0;
    expect(await install(a, exec, 'win32')).toMatch(/Task Scheduler task "Rein schedule"/);
    expect(calls[0]).toMatch(/^schtasks \/Create \/F \/SC MINUTE \/MO 15 \/TN Rein schedule \/TR /);
  });
});
