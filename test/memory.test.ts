import {mkdtempSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {memoryFacts, memoryFile, memoryTools} from '../src/tools/memory.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rein-mem-'));
});

describe('project memory', () => {
  it('remembers dated facts once, forgets by match', async () => {
    const [remember, forget] = memoryTools(() => root);
    await remember!.run({root} as any, {fact: 'Tests run with `make check`, not npm test.'});
    expect((await remember!.run({root} as any, {fact: 'tests run with `make check`, not npm test.'})).text).toBe('Already in project memory.');
    await remember!.run({root} as any, {fact: 'API handlers live in services/api.'});
    expect(memoryFacts(root)).toHaveLength(2);
    expect(memoryFacts(root)[0]).toMatch(/^Tests run with `make check`, not npm test\. \(\d{4}-\d{2}-\d{2}\)$/);
    expect(readFileSync(memoryFile(root), 'utf8')).toMatch(/^# Project memory/);
    expect((await forget!.run({root} as any, {match: 'make check'})).text).toBe('Forgot 1 fact; 1 left.');
    await expect(forget!.run({root} as any, {match: 'nothing like this'})).rejects.toThrow(/no fact/);
  });
});
