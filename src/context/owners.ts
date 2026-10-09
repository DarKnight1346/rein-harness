import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {globToRegExp, ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';

/**
 * Who owns what (/owners): CODEOWNERS (GitHub and GitLab, last matching rule wins), Backstage
 * catalog-info.yaml (spec.owner of the component whose folder holds the file), and, when neither
 * says, the people who changed the file most in its recent history.
 */
export type Rule = {pattern: string; matches: (file: string) => boolean; owners: string[]};
export type Owners = {file: string; owners: string[]; source: 'CODEOWNERS' | 'Backstage' | 'git history' | 'none'};

const CODEOWNERS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'];

/** A CODEOWNERS pattern (gitignore rules) as a test on project-relative paths. */
export function patternMatcher(pattern: string): (file: string) => boolean {
  let p = pattern;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  // Without a slash inside, a pattern matches at any depth (gitignore rules), from a path segment's start.
  const lead = anchored || p.includes('/') ? '' : '(?:.*/)?';
  const body = globToRegExp(p).source.slice(1, -1);
  const self = new RegExp(`^${lead}${body}$`);
  const inside = new RegExp(`^${lead}${body}/.*$`); // a folder pattern covers everything under it
  return (file) => (!dirOnly && self.test(file)) || inside.test(file);
}

export function parseCodeowners(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || /^\^?\[.*\]/.test(line)) continue; // GitLab section headers
    const [pattern, ...owners] = line.split(/\s+/);
    if (pattern) rules.push({pattern, matches: patternMatcher(pattern), owners});
  }
  return rules;
}

export function loadCodeowners(root: string): Rule[] {
  for (const f of CODEOWNERS) {
    try {
      return parseCodeowners(readFileSync(path.join(root, f), 'utf8'));
    } catch {}
  }
  return [];
}

/** Backstage components: folder (project-relative) → owner, from catalog-info.yaml files. */
export async function backstageOwners(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rg = await ripgrep();
  if (!rg) return out;
  const r = await run(rg, ['--files', '-g', 'catalog-info.y*ml', '--color', 'never'], {cwd: root, timeoutMs: 20_000}).catch(() => undefined);
  for (const f of (r?.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
    try {
      for (const doc of String(readFileSync(path.join(root, f), 'utf8')).split(/^---\s*$/m)) {
        const owner = (parse(doc) as {spec?: {owner?: string}} | null)?.spec?.owner;
        if (owner) out.set(path.dirname(f).replace(/\\/g, '/'), owner);
      }
    } catch {}
  }
  return out;
}

async function historyOwners(root: string, file: string): Promise<string[]> {
  const r = await run('git', ['log', '--since=1 year ago', '-n', '300', '--format=%an', '--', file], {cwd: root, timeoutMs: 20_000}).catch(() => undefined);
  const counts = new Map<string, number>();
  for (const a of (r?.stdout ?? '').split('\n').filter(Boolean)) counts.set(a, (counts.get(a) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a, n]) => `${a} (${n} commit${n === 1 ? '' : 's'})`);
}

export async function ownersOf(root: string, files: string[]): Promise<Owners[]> {
  const rules = loadCodeowners(root);
  const catalog = await backstageOwners(root);
  return Promise.all(
    files.map(async (file) => {
      const f = file.replace(/\\/g, '/');
      const rule = [...rules].reverse().find((r) => r.matches(f)); // the last match wins
      if (rule?.owners.length) return {file: f, owners: rule.owners, source: 'CODEOWNERS' as const};
      const dir = [...catalog.keys()].filter((d) => d === '.' || f === d || f.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
      if (dir !== undefined) return {file: f, owners: [catalog.get(dir)!], source: 'Backstage' as const};
      const hist = existsSync(path.join(root, '.git')) ? await historyOwners(root, f) : [];
      return {file: f, owners: hist, source: hist.length ? ('git history' as const) : ('none' as const)};
    }),
  );
}

/** Owners grouped: "@payments-team: a.ts, b.ts". */
export function formatOwners(list: Owners[]): string {
  const groups = new Map<string, string[]>();
  for (const o of list) {
    const key = o.owners.length ? `${o.owners.join(', ')}  (${o.source})` : 'no owner found';
    groups.set(key, [...(groups.get(key) ?? []), o.file]);
  }
  return [...groups.entries()].map(([who, files]) => `${who}\n${files.slice(0, 12).map((f) => `  ${f}`).join('\n')}${files.length > 12 ? `\n  … ${files.length - 12} more` : ''}`).join('\n');
}
