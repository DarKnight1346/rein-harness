import {run} from '../util/proc.js';
import {digestLog, formatDigest} from '../tools/logDigest.js';

/**
 * The CI watcher (/ci): the checks on the current branch's pull request, through the GitHub CLI
 * (`gh pr checks`), and the failed jobs' logs (`gh run view --log-failed`), digested for the agent.
 */
export type Check = {name: string; bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | string; link: string; workflow?: string};

export async function prChecks(root: string): Promise<{checks: Check[]} | {error: string}> {
  const r = await run('gh', ['pr', 'checks', '--json', 'name,bucket,link,workflow'], {cwd: root, timeoutMs: 60_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));
  // gh exits 8 while checks are pending; the JSON is still there.
  try {
    const checks = JSON.parse(r.stdout) as Check[];
    if (Array.isArray(checks)) return {checks};
  } catch {}
  const msg = (r.stderr || r.stdout).trim().split('\n').pop() ?? 'gh failed';
  return {error: /ENOENT|not found/i.test(msg) ? "the GitHub CLI (gh) isn't installed" : msg};
}

export const failed = (cs: Check[]) => cs.filter((c) => c.bucket === 'fail');
export const pending = (cs: Check[]) => cs.filter((c) => c.bucket === 'pending');

export function summary(cs: Check[]): string {
  const count = (b: string) => cs.filter((c) => c.bucket === b).length;
  const parts = [count('pass') && `${count('pass')} passed`, count('fail') && `${count('fail')} failed`, count('pending') && `${count('pending')} running`, count('skipping') && `${count('skipping')} skipped`].filter(Boolean);
  return `${cs.length} check${cs.length === 1 ? '' : 's'}: ${parts.join(', ') || 'none ran'}`;
}

/** The GitHub Actions run behind a check's link (…/actions/runs/<id>/job/<job>). */
export const runId = (link: string) => link.match(/\/actions\/runs\/(\d+)/)?.[1];

/** A failed check's log, digested; the last lines when there's nothing to point at. */
export async function failedLog(root: string, c: Check): Promise<string> {
  const id = runId(c.link);
  if (!id) return `(no GitHub Actions log for this check: ${c.link})`;
  const r = await run('gh', ['run', 'view', id, '--log-failed'], {cwd: root, timeoutMs: 120_000}).catch(() => undefined);
  const log = r?.stdout ?? '';
  if (!log.trim()) return `(couldn't read the log: ${(r?.stderr ?? '').trim().split('\n').pop() ?? 'gh failed'})`;
  return formatDigest(digestLog(log), log.split('\n').length) ?? log.split('\n').slice(-60).join('\n');
}

/** The task for the agent when checks failed. */
export async function fixTask(root: string, fails: Check[], round: number, max: number): Promise<string> {
  const logs = await Promise.all(fails.slice(0, 4).map(async (c) => `### ${c.workflow ? `${c.workflow} / ` : ''}${c.name}\n${await failedLog(root, c)}`));
  return [
    `CI failed on this branch's pull request (fix round ${round} of ${max}). The failing checks and their logs:`,
    '',
    ...logs,
    '',
    "Find the cause and fix it here. Run the failing step locally first if you can. Commit the fix with a clear message. Don't push without asking me; I'll push, or approve your push, and the watcher checks again.",
  ].join('\n');
}

export const MAX_FIX_ROUNDS = 3;

/** /ci watch: poll the PR's checks; when they finish with failures, hand the agent a fix task (a few rounds at most). */
export class CiWatcher {
  private timer: NodeJS.Timeout | undefined;
  private round = 0;
  private handled = '';

  get watching(): boolean {
    return !!this.timer;
  }

  constructor(private readonly deps: {log(text: string, kind?: 'info' | 'error'): void; submit(task: string): void; checks?: typeof prChecks; task?: typeof fixTask}) {}

  start(root: string, everyMs = 60_000): void {
    this.stop();
    this.round = 0;
    this.handled = '';
    this.timer = setInterval(() => void this.tick(root), everyMs);
    this.timer.unref?.();
    void this.tick(root);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(root: string): Promise<void> {
    const res = await (this.deps.checks ?? prChecks)(root);
    if ('error' in res) {
      this.deps.log(`CI watch stopped: ${res.error}`, 'error');
      return this.stop();
    }
    const cs = res.checks;
    if (!cs.length || pending(cs).length) return; // nothing yet, or still running
    const fails = failed(cs);
    if (!fails.length) {
      this.deps.log(`CI passed (${summary(cs)}). Stopped watching.`);
      return this.stop();
    }
    const key = fails.map((c) => c.link).sort().join('\n');
    if (key === this.handled) return; // these failures already went to the agent; waiting for a new run
    this.handled = key;
    if (++this.round > MAX_FIX_ROUNDS) {
      this.deps.log(`CI still failing after ${MAX_FIX_ROUNDS} fix rounds (${fails.map((c) => c.name).join(', ')}). Stopped watching; over to you.`, 'error');
      return this.stop();
    }
    this.deps.log(`CI failed: ${fails.map((c) => c.name).join(', ')}. Handing the logs to the agent (round ${this.round} of ${MAX_FIX_ROUNDS}).`, 'error');
    this.deps.submit(await (this.deps.task ?? fixTask)(root, fails, this.round, MAX_FIX_ROUNDS));
  }
}
