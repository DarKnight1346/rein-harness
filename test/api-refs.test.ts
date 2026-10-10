import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {findApiRefs, formatRefs, parseEndpoint, pathPattern} from '../src/system/api.js';
import {buildGraph} from '../src/system/services.js';

function system() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-api-')));
  const files: Record<string, string> = {
    'services/orders/package.json': '{}',
    'services/orders/openapi.yaml': 'openapi: 3.0.0\npaths:\n  /orders/{id}:\n    get: {responses: {"200": {description: ok}}}\n',
    'services/orders/src/routes.ts': "router.get('/orders/:id', getOrder);\nrouter.post('/orders', createOrder);\n",
    'services/web/package.json': '{}',
    'services/web/src/api.ts': "export const order = (id) => fetch(`${base}/orders/${id}`);\nexport const create = () => axios.post('/orders', body);\nexport const list = () => fetch('/orders?page=2');\n",
    'services/mobile-bff/package.json': '{}',
    'services/mobile-bff/app.py': 'resp = requests.get(f"{ORDERS}/orders/{order_id}")\nrequests.delete("/orders/" + oid)\n',
    'services/web/README.md': 'GET /orders/{id} returns an order\n',
    'services/gateway/package.json': '{}',
    'services/gateway/ingress.yaml': 'kind: Ingress\nspec:\n  rules:\n    - http:\n        paths:\n          - path: /orders\n            backend: {service: {name: orders}}\n',
    'services/ledger/go.mod': 'module x\n',
    'services/ledger/ledger.proto': 'service Ledger {\n  rpc Post(PostRequest) returns (PostReply);\n}\n',
    'services/ledger/server.go': 'func (s *server) Post(ctx context.Context, r *pb.PostRequest) (*pb.PostReply, error) {\n',
    'services/orders/src/ledger.ts': "const ledger = new LedgerClient(addr);\nawait ledger.post(req);\n",
  };
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
    writeFileSync(path.join(root, f), t);
  }
  return root;
}

describe('API-aware find references', () => {
  it('matches a path whatever the parameter syntax', () => {
    const re = pathPattern(parseEndpoint('GET /orders/{id}')!.segments);
    for (const ok of ["fetch(`/orders/${id}`)", "'/orders/:id'", 'f"/orders/{order_id}"', "'/orders/' + oid", '"/orders/42?x=1"']) expect(re.test(ok), ok).toBe(true);
    for (const no of ["'/orders'", "'/orders/42/items'", "'/ordersx/1'"]) expect(re.test(no), no).toBe(false);
    expect(parseEndpoint('FETCH /x')).toBeUndefined();
  });

  it('follows an endpoint from the gateway to the service to every caller', async () => {
    const root = system();
    const g = await buildGraph(root);
    const r = (await findApiRefs(root, g.services, 'GET /orders/{id}'))!;
    expect(r.providers.map((p) => `${p.service} ${p.file}:${p.line}`)).toEqual(['orders services/orders/openapi.yaml:3', 'orders services/orders/src/routes.ts:1']);
    expect(r.consumers.map((p) => `${p.service} ${p.file}:${p.line}`).sort()).toEqual(['mobile-bff services/mobile-bff/app.py:1', 'web services/web/src/api.ts:1']); // the DELETE and the docs aren't
    const create = (await findApiRefs(root, g.services, 'POST /orders'))!;
    expect(create.gateways.map((p) => p.file)).toEqual(['services/gateway/ingress.yaml']);
    expect(create.providers.map((p) => p.line)).toEqual([2]);
    expect(create.consumers.map((p) => `${p.service}:${p.line}`)).toEqual(['web:2']);
    expect(formatRefs(create)).toMatch(/^POST \/orders\nGateway:\n  gateway  services\/gateway\/ingress\.yaml:6/);
  });

  it('follows a gRPC method to its implementation and its clients', async () => {
    const root = system();
    const g = await buildGraph(root);
    const r = (await findApiRefs(root, g.services, 'Ledger.Post'))!;
    expect(r.providers.map((p) => `${p.service} ${p.file}`).sort()).toEqual(['ledger ledger.proto', 'ledger server.go']);
    expect(r.consumers.map((p) => `${p.service} ${p.file}:${p.line}`)).toEqual(['orders src/ledger.ts:2']);
  });
});

describe('call methods', () => {
  it('keeps a fetch whose options are on the next line', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-api2-')));
    for (const [f, t] of Object.entries({'services/orders/package.json': '{}', 'services/orders/r.ts': "router.post('/orders', h);\n", 'services/web/package.json': '{}', 'services/web/a.ts': "await fetch('/orders', {\n  method: 'POST',\n});\n"})) {
      mkdirSync(path.dirname(path.join(root, f)), {recursive: true});
      writeFileSync(path.join(root, f), t);
    }
    const r = (await findApiRefs(root, (await buildGraph(root)).services, 'POST /orders'))!;
    expect(r.consumers.map((c) => `${c.service}:${c.line}`)).toEqual(['web:1']);
  });
});
