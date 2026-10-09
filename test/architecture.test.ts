import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {checkImports, checkProject, importsOf, loadArchitecture, resolveImport} from '../src/tools/architecture.js';
import {ToolHost} from '../src/tools/host.js';

const RULES = `layers:
  ui: "src/ui/**"
  providers: "src/providers/**"
  domain: ["src/domain/**"]
rules:
  - from: ui
    deny: [providers]
    reason: the UI reaches providers through the runtime
  - from: domain
    allow: ["src/shared/**"]
    packages: ["express", "@aws-sdk/*"]
    reason: the domain stays free of frameworks
`;

function project() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-arch-')));
  for (const f of ['src/ui/app.ts', 'src/providers/claude.ts', 'src/domain/order.ts', 'src/shared/money.ts', 'src/runtime.ts']) {
    mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
    writeFileSync(path.join(root, f), 'export const x = 1;\n');
  }
  mkdirSync(path.join(root, '.rein'));
  writeFileSync(path.join(root, '.rein/architecture.yaml'), RULES);
  return root;
}

describe('architecture guardrails', () => {
  it('reads imports in JS/TS, Python and Go and resolves them to project files', () => {
    expect(importsOf('a.ts', "import {a} from './x.js';\nimport type {B} from \"../y\";\nexport * from './z';\nimport './side';\nconst c = require('lodash');\nawait import('@scope/pkg/sub');")).toEqual(['./x.js', '../y', './z', './side', 'lodash', '@scope/pkg/sub']);
    expect(importsOf('a.py', 'from .models import Order\nimport os, json\nfrom billing.charge import run')).toEqual(['.models', 'billing.charge', 'os', 'json']);
    expect(importsOf('a.go', 'import (\n  "fmt"\n  x "acme.dev/shop/internal/db"\n)\nimport "strings"')).toEqual(['strings', 'fmt', 'acme.dev/shop/internal/db']);
    const root = project();
    expect(resolveImport(root, 'src/ui/app.ts', '../providers/claude.js')).toEqual({path: 'src/providers/claude.ts'});
    expect(resolveImport(root, 'src/ui/app.ts', '@aws-sdk/client-s3/dist')).toEqual({pkg: '@aws-sdk/client-s3'});
    writeFileSync(path.join(root, 'go.mod'), 'module acme.dev/shop\n');
    expect(resolveImport(root, 'cmd/main.go', 'acme.dev/shop/src/domain')).toEqual({path: 'src/domain'});
  });

  it('flags only the imports a change adds: deny, allow-only and packages', () => {
    const root = project();
    const arch = loadArchitecture(root)!;
    expect(arch.errors).toEqual([]);
    const ui = checkImports(root, arch, 'src/ui/app.ts', "import {run} from '../runtime.js';\nimport {claude} from '../providers/claude.js';");
    expect(ui.map((v) => [v.import, v.target, v.rule.reason])).toEqual([['../providers/claude.js', 'src/providers/claude.ts', 'the UI reaches providers through the runtime']]);
    const before = "import {claude} from '../providers/claude.js';";
    expect(checkImports(root, arch, 'src/ui/app.ts', `${before}\nimport {run} from '../runtime.js';`, before)).toEqual([]); // an old violation doesn't block
    const domain = checkImports(root, arch, 'src/domain/order.ts', "import {m} from '../shared/money';\nimport {o} from './order';\nimport {run} from '../runtime';\nimport express from 'express';\nimport {S3} from '@aws-sdk/client-s3';\nimport {z} from 'zod';");
    expect(domain.map((v) => v.target)).toEqual(['src/runtime.ts', 'express', '@aws-sdk/client-s3']);
    writeFileSync(path.join(root, '.rein/architecture.yaml'), 'rules:\n  - from: views\n    deny: [db]\n');
    expect(loadArchitecture(root)!.errors).toEqual(['rules[0]: unknown layer views, db (a layer name, or a glob like "src/ui/**")']);
  });

  it('refuses a violating edit through the tool host, warns in warn mode, and /arch finds existing ones', async () => {
    const root = project();
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    await host.call('read', {path: 'src/ui/app.ts'});
    const r = await host.call('edit', {path: 'src/ui/app.ts', old_string: 'export const x = 1;', new_string: "import {c} from '../providers/claude.js';\nexport const x = c;"});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Refused: this change breaks the architecture rules in \.rein[\\/]architecture\.yaml:\n- src\/ui\/app\.ts imports \.\.\/providers\/claude\.js \(src\/providers\/claude\.ts\): the UI reaches providers/);
    expect(readFileSync(path.join(root, 'src/ui/app.ts'), 'utf8')).toBe('export const x = 1;\n');
    writeFileSync(path.join(root, '.rein/architecture.yaml'), `mode: warn\n${RULES}`);
    const w = await host.call('edit', {path: 'src/ui/app.ts', old_string: 'export const x = 1;', new_string: "import {c} from '../providers/claude.js';\nexport const x = c;"});
    expect(w.ok).toBe(true);
    expect(w.text).toMatch(/Note: this change breaks the architecture rules/);
    host.close();
    const {violations} = await checkProject(root, loadArchitecture(root)!);
    expect(violations.map((v) => `${v.file} → ${v.import}`)).toEqual(['src/ui/app.ts → ../providers/claude.js']);
  });
});
