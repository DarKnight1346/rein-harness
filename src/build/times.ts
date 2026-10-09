import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {paths} from '../store/paths.js';
import {isTestCommand} from './flaky.js';

/**
 * Build-time warnings (config buildTimeWarnings): how long each build or test command took on this
 * project, so a change that makes it much slower is noticed. Kept per project in
 * ~/.rein/state/build-times/, the last 10 successful runs of each command.
 */
const BUILD_COMMAND = /\b(?:tsc|make|cmake|ninja|gradlew?|mvnw?|bazel(?:isk)?\s+(?:build|test)|cargo\s+build|go\s+build|webpack|vite\s+build|next\s+build|nx\s+(?:build|run-many|affected)|turbo\s+run|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|dotnet\s+(?:build|test)|swift\s+build|xcodebuild)\b/;
export const isBuildCommand = (command: string) => BUILD_COMMAND.test(command) || isTestCommand(command);

const SLOWER = 1.5;
const MIN_EXTRA_MS = 30_000;
const KEEP = 10;

const file = (root: string) => path.join(paths.state(), 'build-times', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);
const key = (command: string) => command.trim().replace(/\s+/g, ' ');

function load(root: string): Record<string, number[]> {
  try {
    return JSON.parse(readFileSync(file(root), 'utf8'));
  } catch {
    return {};
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

const secs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

/** Record a successful run; returns a warning when it was much slower than usual (at least 3 runs to compare with). */
export function recordBuildTime(root: string, command: string, ms: number): string | undefined {
  const all = load(root);
  const k = key(command);
  const before = all[k] ?? [];
  all[k] = [...before, ms].slice(-KEEP);
  mkdirSync(path.dirname(file(root)), {recursive: true});
  writeFileSync(file(root), JSON.stringify(all));
  if (before.length < 3) return undefined;
  const usual = median(before.slice(-5));
  if (ms < usual * SLOWER || ms - usual < MIN_EXTRA_MS) return undefined;
  return `This took ${secs(ms)}, ${(ms / usual).toFixed(1)}× its usual ${secs(usual)} (median of the last ${Math.min(5, before.length)} runs). Something in this change may have slowed the build or tests.`;
}
