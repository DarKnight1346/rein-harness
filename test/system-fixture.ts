import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A small shop: orders, ledger, web, search and a money package, with every kind of link between them. */
export function shop() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-svc-')));
  const files: Record<string, string> = {
    'services/orders/package.json': JSON.stringify({name: '@shop/orders', dependencies: {'@shop/money': '1.0.0'}}),
    'services/orders/openapi.yaml': 'openapi: 3.0.0\npaths:\n  /orders:\n    post: {responses: {"201": {description: ok}}}\n',
    'services/orders/src/ledger.ts': "import {LedgerClient} from './gen/ledger';\nconst ledger = new LedgerClient(process.env.LEDGER_ADDR);\n",
    'services/ledger/go.mod': 'module acme.dev/ledger\n',
    'services/ledger/ledger.proto': 'syntax = "proto3";\nservice Ledger { rpc Post(PostRequest) returns (PostReply); }\n',
    'services/web/package.json': JSON.stringify({name: '@shop/web'}),
    'services/web/src/api.ts': "const base = process.env.ORDERS_URL ?? 'http://orders:8080';\nexport const create = () => fetch(`${base}/orders`, {method: 'POST'});\n",
    'services/web/k8s/deploy.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: web}\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          env:\n            - {name: SEARCH, value: "http://search.default.svc.cluster.local:9200"}\n',
    'services/search/Dockerfile': 'FROM scratch\n',
    'packages/money/package.json': JSON.stringify({name: '@shop/money'}),
    'docker-compose.yml': 'services:\n  orders:\n    build: services/orders\n    depends_on: [ledger]\n  ledger:\n    build: services/ledger\n',
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
    writeFileSync(path.join(root, f), t);
  }
  return root;
}

