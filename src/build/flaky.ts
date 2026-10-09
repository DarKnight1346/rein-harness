import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {paths} from '../store/paths.js';
import {run} from '../util/proc.js';

/**
 * Flaky-test quarantine (experiment `flaky-quarantine`): each test's outcome is recorded with a
 * fingerprint of the code it ran on (HEAD plus the uncommitted diff). A test that both failed and
 * passed on the same code is flaky. When a run's failures are all known flakes, the agent is told so
 * instead of chasing them. Kept per project in ~/.rein/state/flaky/.
 */
export type Outcomes = {passed: string[]; failed: string[]};
type Record = {flaky: {[test: string]: {flips: number; last: number}}; seen: {[test: string]: {[fingerprint: string]: 'pass' | 'fail' | 'both'}}};

const TEST_COMMAND = /\b(?:vitest|jest|mocha|pytest|py\.test|go\s+test|cargo\s+(?:test|nextest)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)\b/;
export const isTestCommand = (command: string) => TEST_COMMAND.test(command);

/** Test names that passed and failed, from vitest/jest, pytest, go test and cargo test output. */
export function parseOutcomes(output: string): Outcomes {
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*(?:FAIL|×|✕|✗)\s+(.+?)(?:\s+\d+m?s)?$/))) failed.add(m[1]!.trim());
    else if ((m = line.match(/^\s*(?:✓|√|✔)\s+(.+?)(?:\s+\d+m?s)?$/))) passed.add(m[1]!.trim());
    else if ((m = line.match(/^FAILED\s+(\S+::\S+)/))) failed.add(m[1]!);
    else if ((m = line.match(/^(\S+::\S+)\s+PASSED\b/))) passed.add(m[1]!);
    else if ((m = line.match(/^(\S+::\S+)\s+FAILED\b/))) failed.add(m[1]!);
    else if ((m = line.match(/^\s*--- FAIL: (\S+)/))) failed.add(m[1]!);
    else if ((m = line.match(/^\s*--- PASS: (\S+)/))) passed.add(m[1]!);
    else if ((m = line.match(/^test (\S+) \.\.\. FAILED$/))) failed.add(m[1]!);
    else if ((m = line.match(/^test (\S+) \.\.\. ok$/))) passed.add(m[1]!);
  }
  for (const f of failed) passed.delete(f);
  return {passed: [...passed], failed: [...failed]};
}

const file = (root: string) => path.join(paths.state(), 'flaky', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);
function load(root: string): Record {
  try {
    return JSON.parse(readFileSync(file(root), 'utf8'));
  } catch {
    return {flaky: {}, seen: {}};
  }
}
function save(root: string, r: Record): void {
  mkdirSync(path.dirname(file(root)), {recursive: true});
  writeFileSync(file(root), JSON.stringify(r));
}

/** The code a run happened on: HEAD and the uncommitted diff. */
export async function fingerprint(root: string): Promise<string> {
  const git = async (...a: string[]) => (await run('git', a, {cwd: root, timeoutMs: 20_000}).catch(() => undefined))?.stdout ?? '';
  return createHash('sha1').update(await git('rev-parse', 'HEAD')).update(await git('diff', 'HEAD')).digest('hex').slice(0, 16);
}

/** Record a run; returns the tests that just turned out flaky (failed and passed on the same code). */
export function recordRun(root: string, print: string, o: Outcomes): string[] {
  const r = load(root);
  const fresh: string[] = [];
  const mark = (test: string, outcome: 'pass' | 'fail') => {
    const seen = (r.seen[test] ??= {});
    const before = seen[print];
    seen[print] = before && before !== outcome ? 'both' : outcome;
    if (before && before !== outcome && before !== 'both') {
      const f = (r.flaky[test] ??= {flips: 0, last: 0});
      if (!f.flips) fresh.push(test);
      f.flips++;
      f.last = Date.now();
    }
    // Keep a few fingerprints per test: enough to catch a flip, small on disk.
    const keys = Object.keys(seen);
    if (keys.length > 5) delete seen[keys[0]!];
  };
  for (const t of o.passed) mark(t, 'pass');
  for (const t of o.failed) mark(t, 'fail');
  save(root, r);
  return fresh;
}

export function knownFlaky(root: string): string[] {
  return Object.keys(load(root).flaky);
}

export function clearFlaky(root: string): void {
  save(root, {flaky: {}, seen: {}});
}

/** The agent's note for a failing run, when some (or all) of its failures are known flakes. */
export function flakyNote(failed: string[], flaky: string[]): string | undefined {
  const known = failed.filter((f) => flaky.includes(f));
  if (!known.length) return undefined;
  const all = known.length === failed.length;
  return `<flaky_tests>${all ? 'Every failure in this run is' : `${known.length} of the ${failed.length} failures are`} a known flaky test in this repo (it has failed and passed on the same code before): ${known.join(', ')}. ${all ? "Don't chase them: re-run once, and if only these fail again, treat the run as passing and say so." : 'Ignore those; fix the others.'}</flaky_tests>`;
}
