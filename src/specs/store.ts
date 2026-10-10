import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

/**
 * Specs: committed files in `.rein/specs/<name>/`, so they're reviewed in the PR with the code they
 * describe. A spec has three stages, each its own file and each approved before the next:
 * requirements.md (numbered R1, R2… acceptance criteria), design.md, and tasks.md (a checklist of
 * T1, T2… that name the requirements they meet and the tasks they come after). trace.md, written as
 * tasks finish, links each requirement to the code that meets it.
 */
export const STAGES = ['requirements', 'design', 'tasks'] as const;
export type Stage = (typeof STAGES)[number];
export type Task = {id: string; text: string; done: boolean; reqs: string[]; after: string[]};
export type Spec = {name: string; dir: string; title: string; stages: Partial<Record<Stage, {approved: boolean}>>; tasks: Task[]};

export const specsDir = (root: string) => path.join(root, '.rein', 'specs');
export const specDir = (root: string, name: string) => path.join(specsDir(root), name);
const stageFile = (root: string, name: string, stage: Stage) => path.join(specDir(root, name), `${stage}.md`);

/** The first line of an approved stage file. */
const APPROVED = /^<!-- approved (\d{4}-\d{2}-\d{2}) -->\n/;

export const specSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'spec';

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};

export function readStage(root: string, name: string, stage: Stage): {text: string; approved: boolean} | undefined {
  const t = read(stageFile(root, name, stage));
  return t === undefined ? undefined : {text: t.replace(APPROVED, ''), approved: APPROVED.test(t)};
}

/** Saves a stage (not yet approved). Later stages, written against the old version, are no longer approved. */
export function writeStage(root: string, name: string, stage: Stage, text: string): string {
  mkdirSync(specDir(root, name), {recursive: true});
  const f = stageFile(root, name, stage);
  writeFileSync(f, text.trim() + '\n');
  for (const later of STAGES.slice(STAGES.indexOf(stage) + 1)) {
    const s = readStage(root, name, later);
    if (s?.approved) writeFileSync(stageFile(root, name, later), s.text);
  }
  return f;
}

export function approveStage(root: string, name: string, stage: Stage): void {
  const s = readStage(root, name, stage);
  if (!s) throw new Error(`${name} has no ${stage}.md yet`);
  writeFileSync(stageFile(root, name, stage), `<!-- approved ${new Date().toISOString().slice(0, 10)} -->\n${s.text}`);
}

/** The stage that has to come next: the first one missing or not approved. */
export function nextStage(root: string, name: string): Stage | undefined {
  return STAGES.find((s) => !readStage(root, name, s)?.approved);
}

/**
 * Tasks from tasks.md: `- [ ] T3: Add the retry queue (R1, R2) after: T1, T2`. The ids, the
 * requirements and the `after:` list are read loosely, so ordinary markdown around them is fine.
 */
export function parseTasks(md: string): Task[] {
  const out: Task[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+\**(T\d+)\**[:.)\s-]+\s*(.*)$/);
    if (!m) continue;
    const rest = m[3]!;
    const afterPart = rest.match(/\bafter:?\s*((?:T\d+[\s,and]*)+)/i)?.[1] ?? '';
    const body = rest.replace(/\bafter:?\s*(?:T\d+[\s,and]*)+/i, '');
    out.push({
      id: m[2]!,
      text: body.replace(/\s*\((?:R\d+(?:\.\d+)?[\s,]*)+\)\s*/g, ' ').replace(/[\s—–-]+$/, '').trim(),
      done: m[1] !== ' ',
      reqs: [...new Set(body.match(/\bR\d+(?:\.\d+)?\b/g) ?? [])],
      after: [...new Set(afterPart.match(/T\d+/g) ?? [])],
    });
  }
  return out;
}

/** Tasks that can start now: not done, and everything they come after is done. Unknown ids don't block. */
export function readyTasks(tasks: Task[]): Task[] {
  const done = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  const known = new Set(tasks.map((t) => t.id));
  return tasks.filter((t) => !t.done && t.after.every((a) => done.has(a) || !known.has(a)));
}

/** Problems in the graph: dependencies on missing tasks, and cycles. */
export function graphProblems(tasks: Task[]): string[] {
  const ids = new Map(tasks.map((t) => [t.id, t]));
  const problems = tasks.flatMap((t) => t.after.filter((a) => !ids.has(a)).map((a) => `${t.id} comes after ${a}, which isn't a task`));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      problems.push(`cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' → ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const a of ids.get(id)?.after ?? []) if (ids.has(a)) visit(a, [...trail, id]);
    state.set(id, 'done');
  };
  for (const t of tasks) visit(t.id, []);
  return [...new Set(problems)];
}

/** Ticks or unticks a task's box in tasks.md (keeps the approval mark). */
export function setTaskDone(root: string, name: string, id: string, done: boolean): void {
  const f = stageFile(root, name, 'tasks');
  const text = read(f);
  if (text === undefined) throw new Error(`${name} has no tasks.md`);
  const re = new RegExp(`^(\\s*[-*]\\s+\\[)( |x|X)(\\]\\s+\\**${id}\\b)`, 'm');
  if (!re.test(text)) throw new Error(`${name} has no task ${id}`);
  writeFileSync(f, text.replace(re, `$1${done ? 'x' : ' '}$3`));
}

export function readSpec(root: string, name: string): Spec | undefined {
  const dir = specDir(root, name);
  if (!existsSync(dir)) return undefined;
  const stages: Spec['stages'] = {};
  for (const s of STAGES) {
    const st = readStage(root, name, s);
    if (st) stages[s] = {approved: st.approved};
  }
  const req = readStage(root, name, 'requirements')?.text ?? '';
  const title = req.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name;
  return {name, dir, title, stages, tasks: parseTasks(readStage(root, name, 'tasks')?.text ?? '')};
}

export function listSpecs(root: string): Spec[] {
  let names: string[] = [];
  try {
    names = readdirSync(specsDir(root), {withFileTypes: true}).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {}
  return names.map((n) => readSpec(root, n)).filter((s): s is Spec => !!s);
}

export function describeSpec(s: Spec): string {
  const stage = STAGES.map((st) => `${st} ${s.stages[st] ? (s.stages[st]!.approved ? '✓' : '(draft)') : '·'}`).join('  ');
  const done = s.tasks.filter((t) => t.done).length;
  return `${s.name}: ${s.title}\n  ${stage}${s.tasks.length ? `  · tasks ${done}/${s.tasks.length}` : ''}`;
}
