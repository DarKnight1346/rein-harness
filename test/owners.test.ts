import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {formatOwners, ownersOf, patternMatcher} from '../src/context/owners.js';

describe('owners', () => {
  it('matches CODEOWNERS patterns the way GitHub does', () => {
    const m = (p: string, f: string) => patternMatcher(p)(f);
    expect(m('*.js', 'web/app/main.js')).toBe(true);
    expect(m('/docs/', 'docs/guide.md')).toBe(true);
    expect(m('/docs/', 'api/docs/guide.md')).toBe(false); // anchored
    expect(m('docs', 'api/docs/guide.md')).toBe(true); // a bare name: any depth, folders too
    expect(m('docs', 'olddocs/a.md')).toBe(false); // from a segment's start
    expect(m('apps/web/', 'apps/web/src/x.ts')).toBe(true);
    expect(m('apps/web/', 'other/apps/web/x.ts')).toBe(false); // a slash inside: relative to the root
  });

  it('takes the last matching CODEOWNERS rule, then Backstage, then git history', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-own-')));
    const git = (...a: string[]) => execFileSync('git', a, {cwd: root, stdio: 'ignore'});
    git('init', '-q');
    git('config', 'user.email', 'dana@example.com');
    git('config', 'user.name', 'Dana');
    const files: Record<string, string> = {
      '.github/CODEOWNERS': '* @acme/everyone\n/services/payments/ @acme/payments\n',
      'services/payments/charge.ts': 'x',
      'tools/lint.ts': 'x',
      'catalog/search/catalog-info.yaml': 'apiVersion: backstage.io/v1alpha1\nkind: Component\nspec:\n  owner: team-search\n',
      'catalog/search/index.ts': 'x',
    };
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
      writeFileSync(path.join(root, f), t);
    }
    git('add', '.');
    git('commit', '-qm', 'init');
    const o = await ownersOf(root, ['services/payments/charge.ts', 'tools/lint.ts']);
    expect(o).toEqual([
      {file: 'services/payments/charge.ts', owners: ['@acme/payments'], source: 'CODEOWNERS'},
      {file: 'tools/lint.ts', owners: ['@acme/everyone'], source: 'CODEOWNERS'},
    ]);
    writeFileSync(path.join(root, '.github', 'CODEOWNERS'), '/services/ @acme/services\n');
    expect(await ownersOf(root, ['catalog/search/index.ts', 'tools/lint.ts'])).toEqual([
      {file: 'catalog/search/index.ts', owners: ['team-search'], source: 'Backstage'},
      {file: 'tools/lint.ts', owners: ['Dana (1 commit)'], source: 'git history'},
    ]);
    expect(formatOwners(o)).toBe('@acme/payments  (CODEOWNERS)\n  services/payments/charge.ts\n@acme/everyone  (CODEOWNERS)\n  tools/lint.ts');
  });
});
