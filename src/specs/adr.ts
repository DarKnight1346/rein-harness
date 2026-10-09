import {mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

/**
 * Architecture decision records: numbered markdown files (adr-tools and MADR layouts) in docs/adr/
 * or wherever `.adr-dir` points. `/adr new` starts one from a template; with the adr-check
 * experiment, plan and spec mode give the agent the accepted decisions to check its plan against.
 */
export type Adr = {number: number; title: string; status: string; file: string};

const CANDIDATES = ['docs/adr', 'docs/adrs', 'doc/adr', 'adr', 'docs/architecture/decisions', 'docs/decisions', 'architecture/decisions'];

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The project's ADR folder (relative), whether or not it exists yet: `.adr-dir`, a usual place that exists, else docs/adr. */
export function adrDir(root: string): {dir: string; exists: boolean} {
  try {
    const pointed = readFileSync(path.join(root, '.adr-dir'), 'utf8').trim();
    if (pointed) return {dir: pointed, exists: isDir(path.join(root, pointed))};
  } catch {}
  const found = CANDIDATES.find((d) => isDir(path.join(root, d)));
  return {dir: found ?? 'docs/adr', exists: !!found};
}

/** The status line, in the shapes ADRs use: `## Status` then a word, `Status: …`, or MADR front matter. */
function statusOf(text: string): string {
  const m = text.match(/^status:\s*["']?([\w -]+)/im) ?? text.match(/^#{1,3}\s*Status\s*\n+\s*(?:[-*]\s*)?([\w -]+)/im) ?? text.match(/\*\*Status\*\*:?\s*([\w -]+)/i);
  return (m?.[1] ?? 'unknown').trim().toLowerCase();
}

export function listAdrs(root: string): Adr[] {
  const {dir, exists} = adrDir(root);
  if (!exists) return [];
  const out: Adr[] = [];
  for (const f of readdirSync(path.join(root, dir))) {
    const m = f.match(/^(\d+)[-_].*\.md$/i);
    if (!m) continue;
    let text = '';
    try {
      text = readFileSync(path.join(root, dir, f), 'utf8');
    } catch {
      continue;
    }
    const heading = text.match(/^#\s+(.+)$/m)?.[1] ?? f.replace(/^\d+[-_]|\.md$/g, '').replace(/-/g, ' ');
    out.push({number: Number(m[1]), title: heading.replace(/^(?:ADR[- ]?)?\d+[.:]?\s*/i, '').trim(), status: statusOf(text), file: `${dir}/${f}`});
  }
  return out.sort((a, b) => a.number - b.number);
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'decision';

/** Writes the next numbered ADR from the template (status Proposed); returns its project-relative path. */
export function newAdr(root: string, title: string, date = new Date().toISOString().slice(0, 10)): string {
  const {dir} = adrDir(root);
  const n = Math.max(0, ...listAdrs(root).map((a) => a.number)) + 1;
  const rel = `${dir}/${String(n).padStart(4, '0')}-${slug(title)}.md`;
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), {recursive: true});
  // wx: refuses if the file appeared meanwhile, instead of checking first and writing after.
  try {
    writeFileSync(file, adrTemplate(n, title, date), {flag: 'wx'});
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${rel} already exists`);
    throw err;
  }
  return rel;
}

const adrTemplate = (n: number, title: string, date: string) =>
  [`# ${n}. ${title.trim()}`, '', `Date: ${date}`, '', '## Status', '', 'Proposed', '', '## Context', '', '', '## Decision', '', '', '## Consequences', '', ''].join('\n');

/** For plan and spec mode (adr-check): the decisions in force, to check the plan against. */
export function adrContext(root: string): string | undefined {
  const adrs = listAdrs(root).filter((a) => !/superseded|deprecated|rejected/.test(a.status));
  if (!adrs.length) return undefined;
  return [
    `Architecture decisions in force (${adrDir(root).dir}/): check your plan against them and read the ones it touches. If the plan goes against an accepted decision, say so under Risks and propose a new ADR that supersedes it instead of quietly diverging.`,
    ...adrs.slice(0, 60).map((a) => `- ADR ${a.number}: ${a.title} (${a.status}) — ${a.file}`),
  ].join('\n');
}
