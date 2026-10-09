import {readFileSync} from 'node:fs';
import path from 'node:path';
import {diffLines} from 'diff';
import {run} from '../util/proc.js';

/**
 * Static analysis of what a turn changed (config `sast`: "semgrep"), when Semgrep is installed.
 * Only findings on lines the turn added are reported, so a file's old problems don't come back
 * every turn. Semgrep runs with `--metrics=off`; its rules come from `sastConfig` (default "auto").
 */
let available: boolean | undefined;
export async function semgrepAvailable(): Promise<boolean> {
  if (available === undefined) available = await run('semgrep', ['--version'], {timeoutMs: 20_000}).then((r) => r.code === 0).catch(() => false);
  return available;
}

/** Line numbers (1-based) in `now` that weren't in `before`. */
export function addedLines(before: string | null, now: string): Set<number> {
  const out = new Set<number>();
  let line = 1;
  for (const part of diffLines(before ?? '', now)) {
    const n = part.count ?? part.value.split('\n').length - 1;
    if (part.removed) continue;
    if (part.added) for (let i = 0; i < n; i++) out.add(line + i);
    line += n;
  }
  return out;
}

type SemgrepResult = {path: string; start: {line: number}; check_id: string; extra: {message: string; severity: string}};

/** Format Semgrep's JSON results that fall on added lines. */
export function newFindings(json: string, files: {file: string; before: string | null | undefined}[], root: string): string[] {
  let results: SemgrepResult[] = [];
  try {
    results = JSON.parse(json).results ?? [];
  } catch {
    return [];
  }
  const added = new Map<string, Set<number> | 'all'>();
  for (const f of files) {
    let now = '';
    try {
      now = readFileSync(f.file, 'utf8');
    } catch {
      continue;
    }
    added.set(path.resolve(f.file), f.before === undefined ? 'all' : addedLines(f.before, now));
  }
  return results
    .filter((r) => {
      const lines = added.get(path.resolve(root, r.path));
      return lines === 'all' || lines?.has(r.start.line);
    })
    .map((r) => `${path.relative(root, path.resolve(root, r.path)).split(path.sep).join('/')}:${r.start.line}: [${r.extra.severity.toLowerCase()}] ${r.extra.message.trim().split('\n')[0]} (${r.check_id.split('.').pop()})`);
}

export async function sastCheck(files: {file: string; before: string | null | undefined}[], root: string, rules = 'auto'): Promise<string | undefined> {
  if (!files.length || !(await semgrepAvailable())) return undefined;
  const res = await run('semgrep', ['scan', '--json', '--quiet', '--metrics=off', '--config', rules, ...files.map((f) => f.file)], {cwd: root, timeoutMs: 180_000}).catch(() => undefined);
  if (!res?.stdout) return undefined;
  const found = newFindings(res.stdout, files, root);
  if (!found.length) return undefined;
  const lines = found.slice(0, 15);
  return `Semgrep found ${found.length} problem${found.length === 1 ? '' : 's'} in lines this turn added${found.length > lines.length ? ` (first ${lines.length})` : ''}:\n${lines.join('\n')}\nFix ${found.length === 1 ? 'it' : 'them'}, or if one is a false positive, say why in your reply.`;
}
