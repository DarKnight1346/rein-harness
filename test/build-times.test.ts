import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {isBuildCommand, recordBuildTime} from '../src/build/times.js';

beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
});

describe('build-time warnings', () => {
  it('recognizes build and test commands', () => {
    for (const c of ['npm run build', 'npx tsc --noEmit', './gradlew test', 'bazel test //...', 'go test ./...', 'pnpm test', 'make -j8']) expect(isBuildCommand(c), c).toBe(true);
    for (const c of ['git status', 'ls -la', 'npm install']) expect(isBuildCommand(c), c).toBe(false);
  });

  it('warns when a run is much slower than its usual, once it has a few to compare with', () => {
    const root = '/tmp/project-a';
    for (const ms of [60_000, 62_000, 58_000]) expect(recordBuildTime(root, 'npm test', ms)).toBeUndefined();
    expect(recordBuildTime(root, 'npm  test', 70_000)).toBeUndefined(); // a bit slower: fine (and the same command)
    expect(recordBuildTime(root, 'npm test', 150_000)).toMatch(/^This took 2\.5 min, 2\.5× its usual 1\.0 min \(median of the last 4 runs\)/);
    expect(recordBuildTime('/tmp/project-b', 'npm test', 150_000)).toBeUndefined(); // per project
  });

  it('ignores small absolute slowdowns', () => {
    const root = '/tmp/project-c';
    for (const ms of [2000, 2100, 1900]) recordBuildTime(root, 'tsc', ms);
    expect(recordBuildTime(root, 'tsc', 9000)).toBeUndefined(); // 4.5× but only 7 s more
  });
});
