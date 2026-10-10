import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {formatImpact, impactReport, targetOf} from '../src/system/impact.js';
import {buildGraph} from '../src/system/services.js';

const OPENAPI = (fields: string) => `openapi: 3.0.0\npaths:\n  /orders/{id}:\n    get:\n      responses:\n        "200":\n          content:\n            application/json:\n              schema: {type: object, properties: {${fields}}}\n`;

function repo() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-impact-')));
  const write = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
      writeFileSync(path.join(root, f), t);
    }
  };
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: root});
  git('init', '-q');
  write({
    'services/orders/package.json': '{}',
    'services/orders/openapi.yaml': OPENAPI('id: {type: string}, total: {type: integer}'),
    'services/orders/routes.ts': "router.get('/orders/:id', h);\n",
    'packages/money/package.json': '{}',
    'packages/money/format.ts': 'export function formatMoney(c: number) { return `$${c / 100}`; }\n',
    'services/web/package.json': '{}',
    'services/web/order.ts': "import {formatMoney} from '@shop/money';\nconst o = await fetch(`/orders/${id}`);\nshow(formatMoney(o.total));\n",
  });
  git('add', '.');
  git('commit', '-qm', 'base');
  write({
    'services/orders/openapi.yaml': OPENAPI('id: {type: string}'),
    'packages/money/format.ts': 'export function formatMoney(c: number, currency = "USD") { return `${currency} ${c / 100}`; }\n',
  });
  return root;
}

describe('consumer impact report', () => {
  it('maps contract changes to endpoints and RPCs', () => {
    expect(targetOf('api/openapi.yaml', 'GET /orders/{id} 200.total')).toEqual({target: 'GET /orders/{id}', kind: 'endpoint'});
    expect(targetOf('protobuf', 'Orders.List')).toEqual({target: 'Orders.List', kind: 'rpc'});
    expect(targetOf('protobuf', 'Order.total (= 2)')).toBeUndefined();
  });

  it("lists every caller of what the branch changes, breaking first", async () => {
    const root = repo();
    const g = await buildGraph(root);
    const r = await impactReport(root, g.services);
    expect(r.items.map((i) => [i.what, i.kind, i.breaking, i.callers.map((c) => `${c.service} ${c.file}:${c.line}`)])).toEqual([
      ['GET /orders/{id}', 'endpoint', true, ['web services/web/order.ts:2']],
      ['formatMoney', 'symbol', false, ['web services/web/order.ts:1', 'web services/web/order.ts:3']],
    ]);
    const text = formatImpact(r);
    expect(text).toMatch(/^Impact of this branch \(against HEAD\): 2 changed things, 3 callers\n\n✗ breaking GET \/orders\/\{id\}  \(1 caller in 1 service\)\n    ✗ GET \/orders\/\{id\} 200\.total: response field removed\n    web:\n      services\/web\/order\.ts:2/);
  });
});
