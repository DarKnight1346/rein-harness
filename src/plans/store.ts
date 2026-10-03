import {mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

/**
 * Saved plans: markdown files in the project's `.rein/plans/`, so they can be read, edited and
 * committed. Each ends with a `## Milestones` checklist; a goal working from the plan ticks the
 * boxes as milestones are verified, so progress survives sessions. A plan is complete when every
 * box is ticked.
 */
export type Milestone = {text: string; done: boolean};
export type SavedPlan = {file: string; title: string; savedAt: number; milestones: Milestone[]; complete: boolean};

const HEADING = '## Milestones';
const BOX = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/;

export const plansDir = (root: string) => path.join(root, '.rein', 'plans');

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'plan';

/** Write a plan (its own Milestones section, if any, is replaced by `milestones`); returns the file. */
export function savePlan(root: string, p: {title: string; plan: string; milestones: string[]}): string {
  const dir = plansDir(root);
  mkdirSync(dir, {recursive: true});
  const date = new Date().toISOString().slice(0, 10);
  let file = path.join(dir, `${date}-${slug(p.title)}.md`);
  for (let n = 2; exists(file); n++) file = path.join(dir, `${date}-${slug(p.title)}-${n}.md`);
  const body = stripMilestones(p.plan.trim()).replace(/^#\s+.*\n+/, ''); // our own title goes on top
  const text = [`# ${p.title.trim()}`, '', body, '', HEADING, '', ...p.milestones.map((m) => `- [ ] ${m.trim()}`), ''].join('\n');
  writeFileSync(file, text);
  return file;
}

function exists(f: string): boolean {
  try {
    statSync(f);
    return true;
  } catch {
    return false;
  }
}

function stripMilestones(md: string): string {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => /^#{1,6}\s+milestones\b/i.test(l.trim()));
  if (i < 0) return md;
  let j = i + 1;
  while (j < lines.length && !/^#{1,6}\s/.test(lines[j]!.trim())) j++;
  return [...lines.slice(0, i), ...lines.slice(j)].join('\n').trim();
}

export function readPlan(file: string): SavedPlan | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() || path.basename(file, '.md');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === HEADING.toLowerCase());
  const milestones: Milestone[] = [];
  if (start >= 0)
    for (const l of lines.slice(start + 1)) {
      if (/^#{1,6}\s/.test(l.trim())) break;
      const m = BOX.exec(l);
      if (m) milestones.push({text: m[2]!, done: m[1] !== ' '});
    }
  return {file, title, savedAt: statSync(file).mtimeMs, milestones, complete: milestones.length > 0 && milestones.every((m) => m.done)};
}

/** Every saved plan in the project, newest first. */
export function listPlans(root: string): SavedPlan[] {
  let names: string[];
  try {
    names = readdirSync(plansDir(root)).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  return names
    .map((n) => readPlan(path.join(plansDir(root), n)))
    .filter((p): p is SavedPlan => !!p)
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Tick (or untick) milestone `index` (0-based) in the file. */
export function setMilestone(file: string, index: number, done: boolean): void {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === HEADING.toLowerCase());
  if (start < 0) throw new Error('the plan has no Milestones section');
  let n = 0;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]!.trim())) break;
    if (!BOX.test(lines[i]!)) continue;
    if (n++ === index) {
      lines[i] = lines[i]!.replace(/\[( |x|X)\]/, done ? '[x]' : '[ ]');
      writeFileSync(file, lines.join('\n'));
      return;
    }
  }
  throw new Error(`no milestone ${index + 1}`);
}

/** "3/5 milestones" + percent. */
export function progress(p: SavedPlan): {done: number; total: number; pct: number} {
  const done = p.milestones.filter((m) => m.done).length;
  const total = p.milestones.length;
  return {done, total, pct: total ? Math.round((done / total) * 100) : 0};
}
