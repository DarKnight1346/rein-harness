import {describe, expect, it} from 'vitest';
import {formatMutation, strykerSurvivors} from '../src/build/mutate.js';

const REPORT = JSON.stringify({
  schemaVersion: '1',
  files: {
    'src/price.ts': {
      language: 'typescript',
      mutants: [
        {id: '1', mutatorName: 'EqualityOperator', replacement: 'total >= limit', status: 'Survived', location: {start: {line: 12, column: 7}, end: {line: 12, column: 20}}},
        {id: '2', mutatorName: 'BooleanLiteral', status: 'Killed', location: {start: {line: 14, column: 3}, end: {line: 14, column: 7}}},
        {id: '3', mutatorName: 'ArithmeticOperator', replacement: 'a - b', status: 'NoCoverage', location: {start: {line: 20, column: 10}, end: {line: 20, column: 15}}},
      ],
    },
  },
});

describe('mutation testing', () => {
  it("reads Stryker's report: survived and uncovered mutants are the gaps", () => {
    const s = strykerSurvivors(REPORT, '/repo');
    expect(s).toEqual([
      {file: 'src/price.ts', line: 12, mutator: 'EqualityOperator', replacement: 'total >= limit'},
      {file: 'src/price.ts', line: 20, mutator: 'ArithmeticOperator', replacement: 'a - b'},
    ]);
    expect(formatMutation({tool: 'stryker', survivors: s})).toBe('stryker: 2 mutants survived (the tests still pass with these bugs planted):\n  src/price.ts:12 EqualityOperator → total >= limit\n  src/price.ts:20 ArithmeticOperator → a - b');
    expect(formatMutation({tool: 'stryker', survivors: []})).toMatch(/every mutant in the changed files was caught/);
  });
});
