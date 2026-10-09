import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {deadCodeTask, findDeadCode, findFlags, flagRemovalTask, formatFlags, isStale, localFlagStates} from '../src/contracts/deadcode.js';

function project(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-dead-')));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
    writeFileSync(path.join(root, f), t);
  }
  return root;
}

describe('dead code', () => {
  it('finds definitions nothing else names, skipping entry points, tests and used ones', async () => {
    const root = project({
      'package.json': JSON.stringify({main: 'src/lib/api.js'}),
      'src/lib/api.ts': 'export function publicApi() {}\n',
      'src/money.ts': 'export function format(n: number) { return round(n); }\nexport function round(n: number) { return n; }\nexport const LEGACY_RATE = 3;\nexport type Unused = {a: 1};\n',
      'src/cart.ts': "import {format} from './money';\nexport const total = format(1);\n",
      'src/index.ts': "export * from './cart';\n",
      'src/money.test.ts': 'export function helper() {}\n',
      'billing/charge.py': 'def charge():\n    return refund_all()\n\ndef refund_all():\n    pass\n\ndef old_export():\n    pass\n\ndef _private():\n    pass\n',
      'billing/run.py': 'from billing.charge import charge\ncharge()\n',
      'pkg/util.go': 'package pkg\n\nfunc Used() {}\nfunc Orphan() {}\ntype Shape struct{}\n',
      'cmd/main.go': 'package main\n\nfunc main() { pkg.Used(); var s pkg.Shape }\n',
    });
    const {dead} = await findDeadCode(root);
    expect(dead.map((d) => `${d.file}:${d.line} ${d.name}`).sort()).toEqual(['billing/charge.py:7 old_export', 'pkg/util.go:4 Orphan', 'src/money.ts:3 LEGACY_RATE', 'src/money.ts:4 Unused'].sort());
    expect(deadCodeTask(dead)).toMatch(/^Remove dead code[\s\S]*- pkg\/util\.go:4 func Orphan[\s\S]*Build and run the tests/);
  });
});

describe('stale flags', () => {
  it('reads fully decided flags from flagd and plain flag files', () => {
    const root = project({
      'flags.flagd.json': JSON.stringify({flags: {'new-checkout': {state: 'ENABLED', variants: {on: true, off: false}, defaultVariant: 'on'}, 'beta-search': {state: 'ENABLED', variants: {on: true, off: false}, defaultVariant: 'off', targeting: {if: [{in: ['@acme.com', {var: 'email'}]}, 'on', 'off']}}, 'old-banner': {state: 'DISABLED', variants: {on: true}, defaultVariant: 'on'}}}),
      'config/features.yml': 'dark-mode: true\nrollout-x:\n  enabled: true\n  rollout: 50\n',
    });
    expect(Object.fromEntries(localFlagStates(root, ['flags.flagd.json', 'config/features.yml']))).toEqual({'new-checkout': 'on', 'old-banner': 'off', 'dark-mode': 'on'});
  });

  it('finds flag reads across SDKs, with state and age, and writes the removal task', async () => {
    const root = project({
      'web/checkout.tsx': "if (ldClient.variation('new-checkout', false)) show();\nconst s = client.getBooleanValue('beta-search', false);\n",
      'api/search.py': "if unleash.isEnabled('beta-search'):\n    pass\n",
      'app/models/user.rb': 'Flipper.enabled?(:dark_mode, user)\n',
      'flags.json': JSON.stringify({'new-checkout': true}),
    });
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: root, env: {...process.env, GIT_AUTHOR_DATE: '2025-01-15T12:00:00Z', GIT_COMMITTER_DATE: '2025-01-15T12:00:00Z'}});
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'flags');
    const flags = await findFlags(root);
    expect(flags.map((f) => [f.key, f.state, f.uses.map((u) => `${u.file}:${u.line}`), f.since])).toEqual([
      ['new-checkout', 'on', ['web/checkout.tsx:1'], '2025-01-15'],
      ['beta-search', undefined, ['api/search.py:1', 'web/checkout.tsx:2'], '2025-01-15'],
      ['dark_mode', undefined, ['app/models/user.rb:1'], '2025-01-15'],
    ]);
    expect(flags.every((f) => isStale(f))).toBe(true); // all older than 90 days
    expect(formatFlags(flags)).toMatch(/^  ! new-checkout  \(fully on in the repo's flag files; 1 use: web\/checkout\.tsx:1\)/);
    expect(flagRemovalTask(flags[0]!)).toMatch(/^Remove the feature flag "new-checkout" for good, keeping the behaviour it has when it's on\.\n/);
    expect(flagRemovalTask(flags[1]!)).toMatch(/confirm with the user which side is live/);
  });
});
