import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {declarations, repoMap} from '../src/context/repoMap.js';

describe('repo map', () => {
  it('keeps top-level declarations, not bodies, comments or imports', () => {
    const ts = "import x from 'y';\n// helper\nexport function charge(amount: number): Promise<Receipt> {\n  const fee = 1;\n  return pay(amount + fee);\n}\nexport class Refunds {\n  run() {}\n}\nconst LIMIT = 30;\n";
    expect(declarations(ts)).toEqual(['export function charge(amount: number): Promise<Receipt>', 'export class Refunds', 'const LIMIT = 30;']);
    expect(declarations('def charge(amount):\n    fee = 1\n\nclass Refunds:\n    pass\n')).toEqual(['def charge(amount)', 'class Refunds']);
  });

  it('maps the repo, ranked and within its budget, without tests or vendored code', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-map-')));
    execFileSync('git', ['init', '-q'], {cwd: root});
    const files: Record<string, string> = {
      'src/payments.ts': 'export function charge() {}\nexport function refund() {}\n',
      'src/util/strings.ts': 'export function pad() {}\n',
      'src/payments.test.ts': 'describe("x", () => {})\n',
      'vendor/lib/big.js': 'function huge() {}\n',
    };
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
      writeFileSync(path.join(root, f), t);
    }
    const m = await repoMap(root);
    expect(m.text).toBe('src/payments.ts\n  export function charge()\n  export function refund()\nsrc/util/strings.ts\n  export function pad()');
    expect(m).toMatchObject({files: 2, shown: 2});
    const tiny = await repoMap(root, 18); // 72 characters: the top-ranked file fits, the next one no longer does
    expect(tiny.text.startsWith('src/payments.ts')).toBe(true);
    expect(tiny.shown).toBe(1);
  });
});
