import {readFileSync} from 'node:fs';
import path from 'node:path';

/**
 * Dependency check (config `depCheck`): packages a change adds, through a manifest edit or an install
 * command, are vetted before it runs. Does the package exist (models invent names that attackers then
 * register), is it one letter off a popular one, what license does it have, and does OSV know
 * vulnerabilities in the version being added. Looks things up on the package registries and
 * api.osv.dev; a lookup that fails is skipped, never a reason to block.
 */
export type Ecosystem = 'npm' | 'PyPI' | 'crates.io' | 'Go';
export type Dep = {ecosystem: Ecosystem; name: string; version?: string};

// The most-downloaded packages, the targets typosquats imitate.
const POPULAR: Record<Ecosystem, string[]> = {
  npm: ['react', 'react-dom', 'lodash', 'express', 'axios', 'typescript', 'webpack', 'vite', 'next', 'vue', 'chalk', 'commander', 'debug', 'dotenv', 'moment', 'dayjs', 'uuid', 'jest', 'vitest', 'eslint', 'prettier', 'zod', 'yargs', 'request', 'cross-env', 'rimraf', 'glob', 'minimist', 'body-parser', 'cors', 'jsonwebtoken', 'bcrypt', 'mongoose', 'redis', 'pg', 'mysql2', 'sequelize', 'prisma', 'socket.io', 'ws', 'node-fetch', 'babel-core', 'tailwindcss', 'postcss', 'sass', 'jquery', 'underscore', 'async', 'classnames', 'colors', 'semver', 'inquirer', 'nodemon', 'mocha', 'chai', 'sinon', 'supertest', 'graphql', 'rxjs', 'immer', 'redux', 'electron', 'puppeteer', 'playwright', 'cheerio', 'yaml', 'ini'],
  PyPI: ['requests', 'numpy', 'pandas', 'flask', 'django', 'fastapi', 'pydantic', 'boto3', 'botocore', 'urllib3', 'setuptools', 'six', 'python-dateutil', 'pyyaml', 'certifi', 'idna', 'charset-normalizer', 'cryptography', 'pytest', 'scipy', 'matplotlib', 'scikit-learn', 'torch', 'tensorflow', 'pillow', 'sqlalchemy', 'jinja2', 'click', 'rich', 'httpx', 'aiohttp', 'beautifulsoup4', 'lxml', 'openai', 'anthropic', 'celery', 'redis', 'psycopg2', 'pymongo', 'uvicorn', 'gunicorn', 'colorama', 'tqdm', 'selenium'],
  'crates.io': ['serde', 'serde_json', 'tokio', 'rand', 'clap', 'anyhow', 'thiserror', 'reqwest', 'regex', 'log', 'tracing', 'chrono', 'futures', 'hyper', 'axum', 'syn', 'quote', 'itertools', 'once_cell', 'lazy_static'],
  Go: [],
};

/** Edit distance, counting two swapped letters as one edit. */
function distance(a: string, b: string): number {
  const dp = Array.from({length: a.length + 1}, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      // Two letters swapped (reqeusts) is one slip, the commonest typosquat.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1);
    }
  return dp[a.length]![b.length]!;
}

/** A popular package this name is suspiciously close to (one edit, or the same with - and _ swapped). */
export function lookalike(d: Dep): string | undefined {
  const n = d.name.toLowerCase();
  const norm = (s: string) => s.replace(/[-_.]/g, '');
  return POPULAR[d.ecosystem].find((p) => p !== n && (distance(p, n) === 1 || (norm(p) === norm(n) && p.length > 3)));
}

const exact = (v: string | undefined) => {
  const m = v?.trim().match(/^[=v^~]*\s*(\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?)$/);
  return m?.[1];
};

/** Dependencies a manifest declares. */
export function manifestDeps(file: string, text: string): Dep[] {
  const base = path.basename(file);
  try {
    if (base === 'package.json') {
      const j = JSON.parse(text);
      return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((k) => Object.entries<string>(j?.[k] ?? {}).map(([name, v]) => ({ecosystem: 'npm' as const, name, version: typeof v === 'string' ? v : undefined})));
    }
  } catch {
    return [];
  }
  if (/^requirements.*\.txt$/.test(base))
    return text.split('\n').flatMap((l) => {
      const m = l.replace(/#.*/, '').trim().match(/^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*(?:==\s*([\w.]+)|[<>=!~].*)?$/);
      return m ? [{ecosystem: 'PyPI' as const, name: m[1]!, version: m[2]}] : [];
    });
  if (base === 'Cargo.toml') {
    const section = text.match(/\[(?:dev-)?dependencies\]([\s\S]*?)(?=\n\[|$)/g)?.join('\n') ?? '';
    return [...section.matchAll(/^([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)].map((m) => ({ecosystem: 'crates.io' as const, name: m[1]!, version: m[2] ?? m[3]}));
  }
  if (base === 'go.mod') return [...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)].map((m) => ({ecosystem: 'Go' as const, name: m[1]!, version: m[2]!.replace(/^v/, '')}));
  return [];
}

/** Packages an install command adds (npm/yarn/pnpm/bun add|install, pip install, cargo add, go get). */
export function commandDeps(command: string): Dep[] {
  const out: Dep[] = [];
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/);
    const at = (i: number) => words.slice(i).filter((w) => w && !w.startsWith('-'));
    const [a, b] = words;
    if ((a === 'npm' && (b === 'install' || b === 'i' || b === 'add')) || ((a === 'yarn' || a === 'pnpm' || a === 'bun') && (b === 'add' || b === 'install' || b === 'i')))
      for (const w of at(2)) {
        const m = w.match(/^(@?[^@\s]+)(?:@(.+))?$/);
        if (m && !/^[./~]|:/.test(w)) out.push({ecosystem: 'npm', name: m[1]!, version: m[2]});
      }
    if ((a === 'pip' || a === 'pip3' || a === 'uv' || (a?.startsWith('python') && b === '-m')) && words.includes('install'))
      for (const w of at(words.indexOf('install') + 1)) {
        const m = w.match(/^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?(?:==([\w.]+))?$/);
        if (m && w !== 'install') out.push({ecosystem: 'PyPI', name: m[1]!, version: m[2]});
      }
    if (a === 'cargo' && b === 'add') for (const w of at(2)) out.push({ecosystem: 'crates.io', name: w.split('@')[0]!, version: w.split('@')[1]});
    if (a === 'go' && (b === 'get' || b === 'install')) for (const w of at(2)) out.push({ecosystem: 'Go', name: w.split('@')[0]!, version: w.split('@')[1]?.replace(/^v/, '')});
  }
  return out;
}

/** What a write or edit adds to a manifest: dependencies in the new content that weren't there before. */
export function addedDeps(file: string, before: string, after: string): Dep[] {
  const old = new Set(manifestDeps(file, before).map((d) => `${d.ecosystem}:${d.name}`));
  return manifestDeps(file, after).filter((d) => !old.has(`${d.ecosystem}:${d.name}`));
}

/** The file after an edit (the edit tool's old_string → new_string), to see what it adds before it runs. */
export function afterEdit(file: string, args: any): {before: string; after: string} | undefined {
  let before = '';
  try {
    before = readFileSync(file, 'utf8');
  } catch {}
  if (typeof args?.content === 'string') return {before, after: args.content};
  const edits = Array.isArray(args?.edits) ? args.edits : [args];
  let after = before;
  for (const e of edits) {
    if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') return undefined;
    after = e.replace_all ? after.split(e.old_string).join(e.new_string) : after.replace(e.old_string, e.new_string);
  }
  return {before, after};
}

let fetcher: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(6000)});
/** Tests swap the network for a fake. */
export function setDepFetch(fn: typeof fetcher): void {
  fetcher = fn;
}

const COPYLEFT = /\b(?:A?GPL|LGPL|SSPL|EUPL|OSL|CPAL)\b/i;

/** Registry facts: whether it exists, and its license. Undefined when the lookup failed. */
async function registry(d: Dep): Promise<{exists: boolean; license?: string} | undefined> {
  const url =
    d.ecosystem === 'npm'
      ? `https://registry.npmjs.org/${d.name.split('/').map(encodeURIComponent).join('%2F').replace(/^%40/, '@')}/latest`
      : d.ecosystem === 'PyPI'
        ? `https://pypi.org/pypi/${encodeURIComponent(d.name)}/json`
        : d.ecosystem === 'crates.io'
          ? `https://crates.io/api/v1/crates/${encodeURIComponent(d.name)}`
          : `https://proxy.golang.org/${d.name.toLowerCase()}/@latest`;
  try {
    const r = await fetcher(url, {headers: {'user-agent': 'rein-harness (dependency check)'}});
    if (r.status === 404 || r.status === 410) return {exists: false};
    if (!r.ok) return undefined;
    const j = (await r.json().catch(() => ({}))) as any;
    const license = d.ecosystem === 'npm' ? j.license : d.ecosystem === 'PyPI' ? j.info?.license_expression || j.info?.license : d.ecosystem === 'crates.io' ? j.versions?.[0]?.license : undefined;
    return {exists: true, license: typeof license === 'string' ? license : typeof license?.type === 'string' ? license.type : undefined};
  } catch {
    return undefined;
  }
}

async function vulns(d: Dep): Promise<string[]> {
  const version = exact(d.version);
  if (!version) return [];
  try {
    const r = await fetcher('https://api.osv.dev/v1/query', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({package: {name: d.name, ecosystem: d.ecosystem}, version})});
    if (!r.ok) return [];
    const j = (await r.json()) as {vulns?: {id: string; summary?: string; aliases?: string[]}[]};
    return (j.vulns ?? []).map((v) => [v.aliases?.find((a) => a.startsWith('CVE-')) ?? v.id, v.summary].filter(Boolean).join(': '));
  } catch {
    return [];
  }
}

/** Problems with the packages a change adds, one line each (empty: nothing found). */
export async function checkDeps(deps: Dep[]): Promise<string[]> {
  const problems: string[] = [];
  await Promise.all(
    deps.slice(0, 20).map(async (d) => {
      const label = `${d.name}${d.version ? `@${d.version}` : ''} (${d.ecosystem})`;
      const twin = lookalike(d);
      const reg = await registry(d);
      if (reg && !reg.exists) problems.push(`${label} doesn't exist on the registry${twin ? `; did you mean ${twin}?` : ' (a made-up name someone could register later)'}`);
      else if (twin) problems.push(`${label} looks like the popular package ${twin}: check it isn't a typosquat`);
      if (reg?.exists && !reg.license && d.ecosystem !== 'Go') problems.push(`${label} declares no license`);
      if (reg?.license && COPYLEFT.test(reg.license)) problems.push(`${label} is ${reg.license} (copyleft): check it fits this project's license`);
      for (const v of (await vulns(d)).slice(0, 3)) problems.push(`${label} has a known vulnerability: ${v}`);
    }),
  );
  return problems;
}

export function depMessage(problems: string[], block: boolean): string {
  return block
    ? `blocked by the dependency check:\n${problems.map((p) => `- ${p}`).join('\n')}\nPick another package or version, or ask the user.`
    : `<dependency_check>\n${problems.map((p) => `- ${p}`).join('\n')}\nCheck these before relying on the package; tell the user about any you keep.\n</dependency_check>`;
}
