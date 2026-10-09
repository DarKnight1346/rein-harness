/**
 * A long, failing build/test/CI log boiled down to what to look at: the failing step, the first
 * error lines and the file:line locations they name. Used by the `log-digest` experiment (in front of
 * a failing command's output) and by the CI watcher (on a failed check's log).
 */
export type Digest = {step?: string; errors: string[]; locations: string[]};

const ERROR = /\b(?:error|failed|failure|fatal|panic|exception|traceback|assert(?:ion)?error|cannot find|undefined reference|not found|segmentation fault)\b|✗|×|✕|FAIL\b|ERR!/i;
const NOISE = /^\s*(?:at\s+[\w.<>]+\s+\(node:|at\s+node:|at process\.|at Module\.|npm ERR! (?:A complete log|errno|code)|\d+ (?:passing|pending)\b)/;
// path/file.ext:12, path/file.ext:12:5, path/file.ext(12,5), File "x.py", line 12
const LOCATION = /(?:^|[\s(["'`])((?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z]{1,6})(?::(\d+)(?::\d+)?|\((\d+),\d+\))|File "([^"]+)", line (\d+)/g;
// GitHub Actions groups ("Run npm test"), GitLab sections, Gradle's "> Task :x".
const STEP = /^(?:##\[group\](?:Run )?|section_start:\d+:[\w-]+\r?(?:\x1b\[0K)?|> Task )(.+)$/;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, '');

export function digestLog(log: string, opts: {maxErrors?: number; maxLocations?: number} = {}): Digest {
  const lines = log.split('\n').map(strip);
  let step: string | undefined;
  let failingStep: string | undefined;
  const errors: string[] = [];
  const locations = new Set<string>();
  for (const line of lines) {
    const s = line.match(STEP);
    if (s) step = s[1]!.trim().slice(0, 120);
    if (!ERROR.test(line) || NOISE.test(line)) continue;
    failingStep ??= step;
    const t = line.trim();
    if (t && !errors.includes(t) && errors.length < (opts.maxErrors ?? 8)) errors.push(t.slice(0, 300));
  }
  for (const m of log.matchAll(LOCATION)) {
    const file = m[1] ?? m[4];
    const line = m[2] ?? m[3] ?? m[5];
    if (!file || !line || /node_modules|^node:|\.min\.|^https?$/.test(file)) continue;
    locations.add(`${file.replace(/\\/g, '/')}:${line}`);
    if (locations.size >= (opts.maxLocations ?? 10)) break;
  }
  return {step: failingStep, errors, locations: [...locations]};
}

/** The digest as text for the agent, or undefined when there's nothing to point at. */
export function formatDigest(d: Digest, totalLines: number): string | undefined {
  if (!d.errors.length && !d.locations.length) return undefined;
  return [
    `<log_digest lines="${totalLines}">`,
    ...(d.step ? [`Failing step: ${d.step}`] : []),
    ...(d.errors.length ? ['First errors:', ...d.errors.map((e) => `  ${e}`)] : []),
    ...(d.locations.length ? [`Locations: ${d.locations.join(', ')}`] : []),
    'Start from these; the full output follows.',
    '</log_digest>',
  ].join('\n');
}
