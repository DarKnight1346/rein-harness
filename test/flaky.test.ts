import {execFileSync} from 'node:child_process';
import {mkdtempSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {flakyNote, knownFlaky, parseOutcomes, recordRun} from '../src/build/flaky.js';
import {ToolHost} from '../src/tools/host.js';

beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
});

describe('flaky tests', () => {
  it('reads outcomes from vitest/jest, pytest, go and cargo output', () => {
    expect(parseOutcomes(' ✓ test/a.test.ts > adds 3ms\n × test/a.test.ts > times out 5012ms\n FAIL  test/b.test.ts > b > breaks')).toEqual({passed: ['test/a.test.ts > adds'], failed: ['test/a.test.ts > times out', 'test/b.test.ts > b > breaks']});
    expect(parseOutcomes('FAILED tests/test_api.py::test_retry - AssertionError\ntests/test_api.py::test_ok PASSED')).toEqual({passed: ['tests/test_api.py::test_ok'], failed: ['tests/test_api.py::test_retry']});
    expect(parseOutcomes('--- PASS: TestParse (0.00s)\n--- FAIL: TestRace (0.21s)')).toEqual({passed: ['TestParse'], failed: ['TestRace']});
    expect(parseOutcomes('test cache::evicts ... ok\ntest net::retries ... FAILED')).toEqual({passed: ['cache::evicts'], failed: ['net::retries']});
  });

  it('marks a test flaky once it failed and passed on the same code, not when the code changed', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-flaky-')));
    expect(recordRun(root, 'code-1', {passed: [], failed: ['TestRace', 'TestReal']})).toEqual([]);
    expect(recordRun(root, 'code-2', {passed: ['TestReal'], failed: []})).toEqual([]); // fixed by a change: not flaky
    expect(recordRun(root, 'code-1', {passed: ['TestRace'], failed: []})).toEqual(['TestRace']);
    expect(knownFlaky(root)).toEqual(['TestRace']);
    expect(flakyNote(['TestRace'], ['TestRace'])).toMatch(/^<flaky_tests>Every failure in this run is a known flaky test/);
    expect(flakyNote(['TestRace', 'TestNew'], ['TestRace'])).toMatch(/1 of the 2 failures are a known flaky test.*Ignore those; fix the others/);
    expect(flakyNote(['TestNew'], ['TestRace'])).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('tells the agent when a failing run only failed known flakes', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-flaky-')));
    execFileSync('git', ['init', '-q'], {cwd: root});
    const h = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => ['flaky-quarantine'], steerShell: () => false});
    // `# go test` makes it a test command; printf stands in for the runner's output.
    const run = (line: string, code: number) => h.call('shell', {command: `printf -- '${line}\\n'; exit ${code} # go test`});
    await run('--- FAIL: TestRace', 1);
    await run('--- PASS: TestRace', 0);
    const third = await run('--- FAIL: TestRace', 1);
    expect(third.text).toMatch(/<flaky_tests>Every failure in this run is a known flaky test in this repo .*TestRace/);
    h.close();
  });
});
