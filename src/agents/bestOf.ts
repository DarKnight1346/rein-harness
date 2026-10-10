import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

/**
 * Best-of-N across providers (/bestof): the same task runs at once on Claude and on Codex, each in
 * its own worktree. Then Rein runs the project's tests in both, keeps the result that passes (the
 * smaller change if both do) by merging it into the project, and deletes the other. If neither
 * passes, neither is kept.
 */
export type Contender = {label: string; model: string};
export type Outcome = {label: string; model: string; status: string; lines?: number; passed?: boolean; testOutput?: string};

export type BestOfDeps = {
  spawn(task: string, model: string, name: string): {id: number; done: Promise<{status: string; output: string}>};
  /** Don't merge the agent's worktree when it finishes. */
  hold(id: number): void;
  /** Its worktree and lines changed, or undefined if it changed nothing. */
  result(id: number): Promise<{root: string; lines: number} | undefined>;
  test(command: string, root: string): Promise<{ok: boolean; output: string}>;
  /** Merge into the project (keep) or delete; returns a note on what was merged. */
  release(id: number, keep: boolean): Promise<string | undefined>;
  log(text: string): void;
};

/** The project's test command: package.json scripts.test, make test, pytest, go test or cargo test. */
export function detectTestCommand(root: string): string | undefined {
  const has = (f: string) => existsSync(path.join(root, f));
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {scripts?: Record<string, string>};
    const t = pkg.scripts?.test;
    if (t && !/no test specified/.test(t)) return has('pnpm-lock.yaml') ? 'pnpm test' : has('yarn.lock') ? 'yarn test' : has('bun.lockb') || has('bun.lock') ? 'bun test' : 'npm test';
  } catch {}
  try {
    if (/^test:/m.test(readFileSync(path.join(root, 'Makefile'), 'utf8'))) return 'make test';
  } catch {}
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  if (has('pytest.ini') || has('conftest.py') || has('tox.ini') || (has('pyproject.toml') && /pytest/.test(readFileSync(path.join(root, 'pyproject.toml'), 'utf8')))) return 'python -m pytest -q';
  return undefined;
}

/** The winner: a contender whose tests passed, the smaller change first; none if nothing passed. */
export function pickWinner(outcomes: Outcome[]): Outcome | undefined {
  return outcomes.filter((o) => o.passed && o.lines).sort((a, b) => a.lines! - b.lines!)[0];
}

export async function bestOf(deps: BestOfDeps, task: string, contenders: Contender[], testCommand: string): Promise<{winner?: Outcome; outcomes: Outcome[]; merged?: string}> {
  const runs = contenders.map((c) => {
    const s = deps.spawn(task, c.model, `bestof ${c.label}`);
    deps.hold(s.id);
    return {c, ...s};
  });
  deps.log(`Running it on ${contenders.map((c) => `${c.label} (${c.model})`).join(' and ')} at once, each in its own worktree…`);
  const outcomes: Outcome[] = [];
  for (const r of runs) {
    const finished = await r.done;
    const res = await deps.result(r.id);
    const o: Outcome = {label: r.c.label, model: r.c.model, status: finished.status, ...(res ? {lines: res.lines} : {})};
    if (res) {
      deps.log(`${r.c.label} finished (${res.lines} lines changed); running ${testCommand} in its worktree…`);
      const t = await deps.test(testCommand, res.root);
      o.passed = t.ok;
      o.testOutput = t.output.split('\n').slice(-15).join('\n');
    } else deps.log(`${r.c.label} finished without changing anything.`);
    outcomes.push(o);
  }
  const winner = pickWinner(outcomes);
  let merged: string | undefined;
  for (const r of runs) {
    const keep = r.c.label === winner?.label;
    const note = await deps.release(r.id, keep);
    if (keep) merged = note;
  }
  return {winner, outcomes, merged};
}

export function formatBestOf(r: {winner?: Outcome; outcomes: Outcome[]; merged?: string}, testCommand: string): string {
  const rows = r.outcomes.map((o) => `  ${o.label === r.winner?.label ? '✓' : '·'} ${o.label} (${o.model}): ${o.lines ? `${o.lines} lines changed, ${testCommand} ${o.passed ? 'passed' : 'failed'}` : 'no changes'}`);
  if (!r.winner) {
    const failed = r.outcomes.filter((o) => o.lines && !o.passed);
    return [`Neither result passed ${testCommand}, so neither was kept (your project is unchanged).`, ...rows, ...failed.map((o) => `\n${o.label}'s test output (end):\n${o.testOutput ?? ''}`)].join('\n');
  }
  return [`Kept ${r.winner.label}'s result: its tests passed${r.outcomes.filter((o) => o.passed).length > 1 ? ' (both passed; it was the smaller change)' : ''}. The other was deleted.`, ...rows, ...(r.merged ? [r.merged] : [])].join('\n');
}
