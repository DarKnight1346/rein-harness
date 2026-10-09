import {describe, expect, it} from 'vitest';
import {digestLog, formatDigest} from '../src/tools/logDigest.js';

const CI = [
  '##[group]Run npm ci',
  'added 412 packages in 9s',
  '##[endgroup]',
  '##[group]Run npm test',
  '> vitest run',
  ' ✓ test/a.test.ts (3 tests)',
  ' FAIL  test/auth.test.ts > session > expires after an hour',
  "AssertionError: expected 'active' to be 'expired'",
  ' ❯ test/auth.test.ts:42:18',
  '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  'src/auth/session.ts(88,7): error TS2322: Type string is not assignable to type number.',
  ...Array.from({length: 120}, (_, i) => `noise line ${i}`),
  'Error: Process completed with exit code 1.',
].join('\n');

describe('log digest', () => {
  it('finds the failing step, the first errors and the locations', () => {
    const d = digestLog(CI);
    expect(d.step).toBe('npm test');
    expect(d.errors.slice(0, 3)).toEqual(['FAIL  test/auth.test.ts > session > expires after an hour', "AssertionError: expected 'active' to be 'expired'", 'src/auth/session.ts(88,7): error TS2322: Type string is not assignable to type number.']);
    expect(d.locations).toEqual(['test/auth.test.ts:42', 'src/auth/session.ts:88']);
  });

  it('knows Python tracebacks, and says nothing when there is nothing to point at', () => {
    expect(digestLog('Traceback (most recent call last):\n  File "app/main.py", line 12, in <module>\nValueError: bad').locations).toEqual(['app/main.py:12']);
    expect(formatDigest(digestLog('all good\nnothing here'), 2)).toBeUndefined();
    expect(formatDigest(digestLog(CI), 133)).toMatch(/^<log_digest lines="133">\nFailing step: npm test\nFirst errors:/);
  });
});
