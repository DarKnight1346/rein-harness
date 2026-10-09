import {chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {affected, detectBuild, formatAffected} from '../src/build/affected.js';

function workspace(marker: string) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-mono-')));
  writeFileSync(path.join(root, marker), '{}');
  return root;
}
/** A fake build tool that prints `out` (and records its arguments in args.txt). */
function fakeBin(dir: string, name: string, out: string) {
  mkdirSync(dir, {recursive: true});
  const f = path.join(dir, name);
  writeFileSync(f, `#!/bin/sh\necho "$@" > "${path.join(dir, 'args.txt')}"\ncat <<'EOF'\n${out}\nEOF\n`);
  chmodSync(f, 0o755);
  return f;
}

describe('affected targets', () => {
  it('detects the build system', () => {
    expect(detectBuild(workspace('nx.json'))?.system).toBe('nx');
    expect(detectBuild(workspace('turbo.json'))?.system).toBe('turbo');
    expect(detectBuild(workspace('MODULE.bazel'))?.system).toBe('bazel');
    expect(detectBuild(workspace('pants.toml'))?.system).toBe('pants');
    expect(detectBuild(workspace('package.json'))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('asks Nx which projects the files affect, and how to test them', async () => {
    const root = workspace('nx.json');
    fakeBin(path.join(root, 'node_modules', '.bin'), 'nx', 'api\nweb');
    const a = (await affected(root, ['libs/auth/src/index.ts', 'apps/api/main.ts']))!;
    expect(a).toEqual({system: 'nx', targets: ['api', 'web'], test: 'nx run-many -t test -p api,web'});
    expect(formatAffected(a)).toBe('nx: 2 affected projects:\n  api\n  web\nTest just these: nx run-many -t test -p api,web');
  });

  it.skipIf(process.platform === 'win32')('asks Bazel for the reverse dependencies of the files', async () => {
    const root = workspace('MODULE.bazel');
    const bin = path.join(root, 'bin');
    fakeBin(bin, 'bazel', '//src/auth:lib\n//src/auth:lib_test');
    const prev = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${prev}`;
    try {
      const a = (await affected(root, ['src/auth/session.cc']))!;
      expect(a.targets).toEqual(['//src/auth:lib', '//src/auth:lib_test']);
      expect(a.test).toMatch(/^bazel test \$\(bazel query 'kind\("\.\*_test", rdeps\(\/\/\.\.\., set\(src\/auth\/session\.cc\)\)\)'\)$/);
    } finally {
      process.env.PATH = prev;
    }
  });
});
