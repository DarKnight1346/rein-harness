import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';

/**
 * Dead code and stale flags (/deadcode, /flags). Dead code: exported or top-level definitions that
 * no other file names and their own file uses only once (where they're defined) — candidates, since
 * dynamic use can't be seen. Flags: the flag keys the code reads through the common SDKs, which of
 * them the repo's own flag files say are fully on or off, and how long ago each first appeared.
 */
export type Dead = {file: string; line: number; name: string; kind: string};
export type FlagUse = {key: string; uses: {file: string; line: number}[]; state?: 'on' | 'off'; since?: string; ageDays?: number};

const SOURCE = /\.(?:[cm]?[jt]sx?|py|go)$/;
/** Never dead: entry points and files loaded by name (configs, routes, tests, migrations, stories). */
const ENTRY = /(?:^|\/)(?:index|main|app|server|cli|manage|setup|conftest|__init__|__main__|wsgi|asgi)\.[^/]+$|\.(?:config|setup|stories|spec|test|d)\.[^/]+$|_test\.go$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)(?:pages|app|routes|api|migrations?|tests?|__tests__|scripts|bin|cmd|fixtures|e2e)\//;

async function sourceFiles(root: string): Promise<string[]> {
  const rg = await ripgrep();
  const listed = rg ? ((await run(rg, ['--files', '--color', 'never'], {cwd: root, timeoutMs: 30_000}).catch(() => undefined))?.stdout ?? '') : '';
  return listed.split(/\r?\n/).map((f) => f.replace(/\\/g, '/')).filter((f) => f && SOURCE.test(f) && !/(?:^|\/)(?:node_modules|vendor|dist|build|\.next|generated|__generated__)\//.test(f));
}

/** Entry points named in package.json (main, module, bin, exports): their exports are the package's API. */
function packageEntries(root: string): Set<string> {
  const out = new Set<string>();
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const add = (v: unknown): void => {
      if (typeof v === 'string') out.add(path.normalize(v).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.[cm]?js$/, ''));
      else if (v && typeof v === 'object') Object.values(v).forEach(add);
    };
    [pkg.main, pkg.module, pkg.types, pkg.bin, pkg.exports].forEach(add);
  } catch {}
  return out;
}

function declarations(file: string, text: string): {name: string; line: number; kind: string}[] {
  const out: {name: string; line: number; kind: string}[] = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    let m: RegExpMatchArray | null;
    if (/\.[cm]?[jt]sx?$/.test(file)) {
      if ((m = l.match(/^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|class|const|let|var|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/))) out.push({name: m[2]!, line: i + 1, kind: m[1]!.replace('abstract ', '')});
    } else if (file.endsWith('.py')) {
      if ((m = l.match(/^(def|class|async def)\s+([A-Za-z]\w*)/)) && !m[2]!.startsWith('_')) out.push({name: m[2]!, line: i + 1, kind: m[1] === 'class' ? 'class' : 'function'});
    } else if (file.endsWith('.go')) {
      if ((m = l.match(/^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)\s*[[(]/)) || (m = l.match(/^type\s+([A-Z]\w*)\s/))) out.push({name: m[1]!, line: i + 1, kind: l.startsWith('type') ? 'type' : 'func'});
    }
  });
  return out;
}

/** /deadcode: definitions nothing else refers to (at most `max`). */
export async function findDeadCode(root: string, max = 200): Promise<{dead: Dead[]; files: number}> {
  const files = await sourceFiles(root);
  const entries = packageEntries(root);
  const texts = new Map<string, string>();
  for (const f of files.slice(0, 20_000)) {
    try {
      texts.set(f, readFileSync(path.join(root, f), 'utf8'));
    } catch {}
  }
  // Every identifier, and which files it appears in, with how often.
  const seen = new Map<string, Map<string, number>>();
  for (const [f, t] of texts) for (const w of t.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    const byFile = seen.get(w) ?? new Map<string, number>();
    byFile.set(f, (byFile.get(f) ?? 0) + 1);
    seen.set(w, byFile);
  }
  // Files re-exported whole (`export * from './x'`, a barrel): their exports are public through it.
  const reexported = new Set<string>();
  for (const [f, t] of texts)
    for (const m of t.matchAll(/^export\s+\*\s+(?:as\s+\w+\s+)?from\s+['"](\.[^'"]+)['"]/gm)) reexported.add(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]!)).replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, ''));
  const dead: Dead[] = [];
  for (const [f, t] of texts) {
    const stem = f.replace(/\.[cm]?[jt]sx?$/, '');
    if (ENTRY.test(f) || entries.has(stem) || reexported.has(stem) || reexported.has(stem.replace(/\/index$/, ''))) continue;
    for (const d of declarations(f, t)) {
      const where = seen.get(d.name);
      const elsewhere = [...(where?.keys() ?? [])].some((g) => g !== f);
      if (!elsewhere && (where?.get(f) ?? 0) <= 1) dead.push({file: f, line: d.line, name: d.name, kind: d.kind});
      if (dead.length >= max) return {dead, files: texts.size};
    }
  }
  return {dead, files: texts.size};
}

/** Flag reads through common SDKs: the first string argument is the key. */
const FLAG_CALLS = [
  /\b(?:variation|boolVariation|stringVariation|intVariation|jsonVariation|variationDetail)\(\s*['"`]([\w.:-]+)['"`]/g, // LaunchDarkly
  /\bisEnabled\(\s*['"`]([\w.:-]+)['"`]/g, // Unleash, generic
  /\bget(?:Boolean|String|Number|Integer|Object)(?:Value|Details)\(\s*['"`]([\w.:-]+)['"`]/g, // OpenFeature
  /\b(?:isOn|isOff|getFeatureValue|evalFeature)\(\s*['"`]([\w.:-]+)['"`]/g, // GrowthBook
  /\b(?:hasFeature|isFeatureEnabled)\(\s*['"`]([\w.:-]+)['"`]/g, // Flagsmith
  /\bgetTreatment\(\s*(?:[\w.]+\s*,\s*)?['"`]([\w.:-]+)['"`]/g, // Split
  /\bFlipper\.enabled\?\(\s*:([\w]+)/g, // Flipper (Ruby)
  /\b(?:feature_flag|flag_enabled|is_flag_on|feature_enabled)\(\s*['"]([\w.:-]+)['"]/g, // generic Python helpers
];

/** Flag state from the repo's own flag files: OpenFeature flagd, or plain JSON/YAML of booleans. */
export function localFlagStates(root: string, files: string[]): Map<string, 'on' | 'off'> {
  const out = new Map<string, 'on' | 'off'>();
  for (const f of files.filter((x) => /(?:^|\/)(?:[\w.-]*flags?[\w.-]*|features?)\.(?:json|ya?ml)$/i.test(x) && !/package(?:-lock)?\.json$/.test(x))) {
    let doc: any;
    try {
      doc = parseYaml(readFileSync(path.join(root, f), 'utf8'));
    } catch {
      continue;
    }
    const flags = doc?.flags && typeof doc.flags === 'object' ? doc.flags : doc;
    if (!flags || typeof flags !== 'object') continue;
    for (const [key, v] of Object.entries<any>(flags)) {
      if (typeof v === 'boolean') out.set(key, v ? 'on' : 'off');
      else if (v && typeof v === 'object' && v.variants && v.defaultVariant !== undefined) {
        // flagd: fully decided when disabled, or enabled with no targeting rules.
        const value = v.variants[v.defaultVariant];
        const targeted = v.targeting && Object.keys(v.targeting).length > 0;
        if (v.state === 'DISABLED') out.set(key, 'off');
        else if (!targeted && typeof value === 'boolean') out.set(key, value ? 'on' : 'off');
      } else if (v && typeof v === 'object' && typeof v.enabled === 'boolean' && !v.rules && !v.targeting && (v.rollout === undefined || v.rollout === 100 || v.rollout === 0)) out.set(key, v.enabled && v.rollout !== 0 ? 'on' : 'off');
    }
  }
  return out;
}

/** /flags: every flag key read in the code, its state in the repo's flag files, and its age (first appearance in git). */
export async function findFlags(root: string, opts: {history?: boolean} = {}): Promise<FlagUse[]> {
  const rg = await ripgrep();
  const all = rg ? ((await run(rg, ['--files', '--color', 'never'], {cwd: root, timeoutMs: 30_000}).catch(() => undefined))?.stdout ?? '').split(/\r?\n/).map((f) => f.replace(/\\/g, '/')).filter(Boolean) : [];
  const code = all.filter((f) => /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php|swift)$/.test(f) && !/(?:^|\/)(?:node_modules|vendor|dist|build)\//.test(f));
  const uses = new Map<string, {file: string; line: number}[]>();
  for (const f of code.slice(0, 20_000)) {
    let text: string;
    try {
      text = readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    for (const re of FLAG_CALLS)
      for (const m of text.matchAll(re)) uses.set(m[1]!, [...(uses.get(m[1]!) ?? []), {file: f, line: text.slice(0, m.index).split('\n').length}]);
  }
  const states = localFlagStates(root, all);
  const byPlace = (a: {file: string; line: number}, b: {file: string; line: number}) => a.file.localeCompare(b.file) || a.line - b.line;
  const out: FlagUse[] = [...uses].map(([key, u]) => ({key, uses: u.sort(byPlace), ...(states.has(key) ? {state: states.get(key)} : {})}));
  if (opts.history !== false)
    for (const f of out.slice(0, 60)) {
      const r = await run('git', ['log', '--reverse', '--format=%as', '-S', f.key, '--', ...new Set(f.uses.map((u) => u.file))], {cwd: root, timeoutMs: 20_000}).catch(() => undefined);
      const first = r?.stdout.split('\n').find(Boolean);
      if (first) Object.assign(f, {since: first, ageDays: Math.floor((Date.now() - Date.parse(first)) / 86_400_000)});
    }
  return out.sort((a, b) => Number(!!b.state) - Number(!!a.state) || (b.ageDays ?? 0) - (a.ageDays ?? 0) || a.key.localeCompare(b.key));
}

export const isStale = (f: FlagUse, days = 90) => f.state !== undefined || (f.ageDays ?? 0) >= days;

export function formatFlags(flags: FlagUse[], days = 90): string {
  return flags
    .map((f) => {
      const why = f.state ? `fully ${f.state} in the repo's flag files` : (f.ageDays ?? 0) >= days ? `${f.ageDays} days old` : f.ageDays !== undefined ? `${f.ageDays} days old` : 'age unknown';
      return `  ${isStale(f, days) ? '!' : ' '} ${f.key}  (${why}; ${f.uses.length} use${f.uses.length === 1 ? '' : 's'}: ${f.uses.slice(0, 3).map((u) => `${u.file}:${u.line}`).join(', ')}${f.uses.length > 3 ? ', …' : ''})`;
    })
    .join('\n');
}

/** The campaign message: remove a flag, keeping the branch that is live. */
export function flagRemovalTask(f: FlagUse): string {
  const keep = f.state === 'off' ? 'off' : 'on';
  return [
    `Remove the feature flag "${f.key}" for good, keeping the behaviour it has when it's ${keep}${f.state ? '' : " (it isn't fully decided in the repo's flag files: confirm with the user which side is live before you start)"}.`,
    `Where it's read:\n${f.uses.map((u) => `- ${u.file}:${u.line}`).join('\n')}`,
    `At each read, keep the ${keep} branch and delete the other, then remove what becomes unused (helpers, components, imports, tests of the removed branch, its entry in flag files and default configs). Search for other spellings of the key (constants, enums, camelCase). Build and run the tests; then list what you removed, and remind the user to archive the flag in their flag service.`,
  ].join('\n\n');
}

export function deadCodeTask(dead: Dead[]): string {
  return [
    `Remove dead code. Nothing in the project refers to these definitions (found by name, so check each before deleting: dynamic imports, reflection, string-based lookups, framework conventions, public API of a published package):`,
    dead.map((d) => `- ${d.file}:${d.line} ${d.kind} ${d.name}`).join('\n'),
    'Delete the ones that are really unused, and anything that becomes unused with them (imports, helpers, tests that only cover them, empty files). Keep the rest and say why. Build and run the tests, then summarize what you removed.',
  ].join('\n\n');
}
