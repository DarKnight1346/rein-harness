import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {adrContext, adrDir, listAdrs, newAdr} from '../src/specs/adr.js';

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-adr-')));

describe('architecture decision records', () => {
  it('reads adr-tools and MADR records, statuses included', () => {
    const root = tmp();
    mkdirSync(path.join(root, 'docs/adr'), {recursive: true});
    writeFileSync(path.join(root, 'docs/adr/0001-record-architecture-decisions.md'), '# 1. Record architecture decisions\n\nDate: 2024-01-01\n\n## Status\n\nAccepted\n');
    writeFileSync(path.join(root, 'docs/adr/0002-use-mongo.md'), '# 2. Use MongoDB\n\n## Status\n\nSuperseded by [3](0003-use-postgres.md)\n');
    writeFileSync(path.join(root, 'docs/adr/0003-use-postgres.md'), '---\nstatus: accepted\ndate: 2024-03-01\n---\n# Use Postgres for the ledger\n');
    writeFileSync(path.join(root, 'docs/adr/README.md'), '# ADRs');
    expect(listAdrs(root).map((a) => [a.number, a.title, a.status])).toEqual([
      [1, 'Record architecture decisions', 'accepted'],
      [2, 'Use MongoDB', 'superseded by'],
      [3, 'Use Postgres for the ledger', 'accepted'],
    ]);
    const ctx = adrContext(root)!;
    expect(ctx).toMatch(/check your plan against them/);
    expect(ctx).toContain('- ADR 3: Use Postgres for the ledger (accepted) — docs/adr/0003-use-postgres.md');
    expect(ctx).not.toContain('MongoDB');
  });

  it('starts the next record where .adr-dir points, and stays quiet without any', () => {
    const root = tmp();
    expect(adrContext(root)).toBeUndefined();
    expect(adrDir(root)).toEqual({dir: 'docs/adr', exists: false});
    writeFileSync(path.join(root, '.adr-dir'), 'architecture/adr\n');
    expect(newAdr(root, 'Use Postgres', '2026-10-09')).toBe('architecture/adr/0001-use-postgres.md');
    expect(newAdr(root, 'Queue retries in Redis', '2026-10-09')).toBe('architecture/adr/0002-queue-retries-in-redis.md');
    expect(readFileSync(path.join(root, 'architecture/adr/0002-queue-retries-in-redis.md'), 'utf8')).toBe('# 2. Queue retries in Redis\n\nDate: 2026-10-09\n\n## Status\n\nProposed\n\n## Context\n\n\n## Decision\n\n\n## Consequences\n\n');
    expect(listAdrs(root).map((a) => a.status)).toEqual(['proposed', 'proposed']);
  });
});
