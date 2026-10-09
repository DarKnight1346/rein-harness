import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {loadPacks, packFiles, packMessage, savePack} from '../src/context/packs.js';

function project() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-pack-')));
  execFileSync('git', ['init', '-q'], {cwd: root});
  for (const f of ['services/payments/charge.ts', 'services/payments/refund.ts', 'services/users/user.ts', 'docs/payments.md']) {
    mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
    writeFileSync(path.join(root, f), `// ${f}\n`);
  }
  return root;
}

describe('context packs', () => {
  it('saves and loads packs in .rein/packs.yaml, and expands their globs to files', async () => {
    const root = project();
    expect(loadPacks(root)).toEqual({packs: []});
    savePack(root, {name: 'payments', files: ['services/payments/**', 'docs/payments.md'], note: 'the payments flow'});
    const {packs} = loadPacks(root);
    expect(packs).toEqual([{name: 'payments', files: ['services/payments/**', 'docs/payments.md'], note: 'the payments flow'}]);
    const {files, more} = await packFiles(root, packs[0]!);
    expect(files.sort()).toEqual(['docs/payments.md', 'services/payments/charge.ts', 'services/payments/refund.ts']);
    expect(more).toBe(0);
  });

  it('turns a pack into @mentions plus what you asked', () => {
    expect(packMessage({name: 'payments', files: [], note: 'the payments flow'}, ['a.ts', 'b.md'], 'add refunds over 30 days')).toBe('Context pack "payments" (the payments flow): @a.ts @b.md\n\nadd refunds over 30 days');
  });

  it('accepts a plain list per pack, and reports a broken file', () => {
    const root = project();
    mkdirSync(path.join(root, '.rein'));
    writeFileSync(path.join(root, '.rein', 'packs.yaml'), 'users: [services/users/**]\n');
    expect(loadPacks(root).packs).toEqual([{name: 'users', files: ['services/users/**']}]);
    writeFileSync(path.join(root, '.rein', 'packs.yaml'), 'users: [unclosed\n');
    expect(loadPacks(root).error).toMatch(/^\.rein\/packs\.yaml: /);
  });
});
