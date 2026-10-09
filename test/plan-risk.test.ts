import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {formatRisk, plannedFiles, planRisk} from '../src/plans/risk.js';

function project() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-risk-')));
  for (const f of ['services/payments/charge.ts', 'services/ledger/post.ts', 'api/openapi.yaml', 'db/migrations/0042_split.sql', 'README.md', '.github/CODEOWNERS']) {
    mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
    writeFileSync(path.join(root, f), 'x\n');
  }
  writeFileSync(path.join(root, '.github/CODEOWNERS'), 'services/payments/ @acme/payments\nservices/ledger/ @acme/ledger\napi/ @acme/platform\n');
  return root;
}

describe('plan risk', () => {
  it('finds the files a plan names, ignoring ones that do not exist', () => {
    const root = project();
    expect(plannedFiles(root, '1. Change `services/payments/charge.ts` and ./README.md.\n2. Update services/ledger/ (and the nonexistent src/x.ts).')).toEqual(['services/payments/charge.ts', 'README.md', 'services/ledger/']);
  });

  it('scores files, services, owners, contracts and migrations', async () => {
    const root = project();
    const small = await planRisk(root, 'Fix the typo in README.md');
    expect(small).toMatchObject({level: 'low', files: ['README.md'], contracts: [], migrations: []});
    const big = await planRisk(root, 'Edit services/payments/charge.ts and services/ledger/post.ts, add a field to api/openapi.yaml, write db/migrations/0042_split.sql');
    expect(big.level).toBe('high');
    expect(big.services).toEqual(['services/payments', 'services/ledger', 'api', 'db']);
    expect([...big.owners].sort()).toEqual(['@acme/ledger', '@acme/payments', '@acme/platform']);
    expect(formatRisk(big)).toBe('Risk: high (4 files, 4 services, 3 owners)\n  contracts: api/openapi.yaml\n  migrations: db/migrations/0042_split.sql\n  owners: @acme/payments, @acme/ledger, @acme/platform\n  services: services/payments, services/ledger, api, db');
    expect(formatRisk(await planRisk(root, 'Make it faster'))).toBe('Risk: unknown (the plan names no files in this project).');
  });
});
