import {describe, expect, it} from 'vitest';
import {contractKind, diffContract, formatChanges, type Change} from '../src/contracts/diff.js';

const show = (cs: Change[]) => cs.map((c) => `${c.kind === 'breaking' ? '✗' : '✓'} ${c.where}: ${c.what}`);

describe('contract-change detector', () => {
  it('knows contract files', () => {
    expect([contractKind('api/openapi.yaml'), contractKind('x.json', '{"swagger": "2.0"}'), contractKind('a.proto'), contractKind('s.graphql'), contractKind('e.avsc'), contractKind('config.yaml', 'name: x')]).toEqual(['openapi', 'openapi', 'protobuf', 'graphql', 'avro', undefined]);
  });

  it('OpenAPI: removed operations and response fields, new required inputs, type and enum changes', () => {
    const before = `openapi: 3.0.0
paths:
  /orders/{id}:
    parameters: [{name: id, in: path, required: true, schema: {type: string}}]
    get:
      parameters: [{name: expand, in: query, schema: {type: string}}]
      responses:
        '200': {content: {application/json: {schema: {$ref: '#/components/schemas/Order'}}}}
    delete: {responses: {'204': {description: gone}}}
  /orders:
    post:
      requestBody: {required: true, content: {application/json: {schema: {type: object, required: [sku], properties: {sku: {type: string}, note: {type: string}}}}}}
      responses: {'201': {description: created}}
components:
  schemas:
    Order: {type: object, required: [id, status], properties: {id: {type: string}, total: {type: integer}, status: {type: string, enum: [open, paid]}}}
`;
    const after = before
      .replace("    delete: {responses: {'204': {description: gone}}}\n", '')
      .replace("parameters: [{name: expand, in: query, schema: {type: string}}]", "parameters: [{name: expand, in: query, schema: {type: string}}, {name: tenant, in: header, required: true, schema: {type: string}}, {name: fields, in: query, schema: {type: string}}]")
      .replace('required: [sku], properties: {sku: {type: string}, note: {type: string}}', 'required: [sku, qty], properties: {sku: {type: string}, qty: {type: integer}, note: {type: string}}')
      .replace('total: {type: integer}', 'total: {type: string}, currency: {type: string}')
      .replace('enum: [open, paid]', 'enum: [open, paid, refunded]');
    expect(show(diffContract('openapi', before, after)).sort()).toEqual([
      '✓ GET /orders/{id} 200.currency: response field added',
      '✓ GET /orders/{id} query fields: optional parameter added',
      '✗ DELETE /orders/{id}: operation removed',
      '✗ GET /orders/{id} 200.status: new enum values clients may not handle: refunded',
      '✗ GET /orders/{id} 200.total: type changed from integer to string',
      '✗ GET /orders/{id} header tenant: new required parameter',
      '✗ POST /orders body.qty: new required request field',
    ].sort());
  });

  it('protobuf: removed fields need reserved numbers; type, number and rpc changes break', () => {
    const before = 'syntax = "proto3";\npackage shop.v1;\n// Orders\nmessage Order {\n  string id = 1;\n  int64 total = 2;\n  string note = 3;\n  repeated string tags = 4;\n  message Line { string sku = 1; }\n}\nenum Status { OPEN = 0; PAID = 1; }\nservice Orders {\n  rpc Get(GetRequest) returns (Order);\n  rpc List(ListRequest) returns (stream Order);\n}\n';
    const after = 'syntax = "proto3";\npackage shop.v1;\nmessage Order {\n  reserved 3;\n  string id = 1;\n  string total = 2;\n  string tags = 4;\n  string currency = 5;\n  message Line { string sku = 1; int32 qty = 2; }\n}\nenum Status { OPEN = 0; }\nservice Orders {\n  rpc Get(GetRequest) returns (Order);\n  rpc List(ListRequest) returns (Order);\n  rpc Cancel(CancelRequest) returns (Order);\n}\n';
    expect(show(diffContract('protobuf', before, after))).toEqual([
      '✗ Order.total (= 2): type changed from int64 to string',
      '✓ Order.note (= 3): field removed (its number is reserved)',
      '✗ Order.tags (= 4): changed from repeated',
      '✓ Order.currency (= 5): field added',
      '✓ Order.Line.qty (= 2): field added',
      '✗ Status.PAID: enum value removed',
      '✗ Orders.List: rpc signature changed from (ListRequest) returns (stream Order) to (ListRequest) returns (Order)',
      '✓ Orders.Cancel: rpc added',
    ]);
    expect(show(diffContract('protobuf', 'message A { string x = 1; string y = 2; }', 'message A { string x = 1; }'))).toEqual(['✗ A.y (= 2): field removed without reserving its number: a later field could reuse it']);
  });

  it('GraphQL: removed fields, nullability by direction, required arguments', () => {
    const before = 'type Query {\n  order(id: ID!): Order\n  orders(first: Int): [Order!]!\n}\ntype Order { id: ID!, total: Int!, note: String }\ninput NewOrder { sku: String! qty: Int }\nenum Status { OPEN PAID }';
    const after = 'type Query {\n  order(id: ID!, tenant: String!): Order\n  orders(first: Int, after: String): [Order!]!\n}\ntype Order { id: ID!, total: Int, currency: String }\ninput NewOrder { sku: String! qty: Int! }\nenum Status { OPEN PAID REFUNDED }';
    expect(show(diffContract('graphql', before, after)).sort()).toEqual([
      '✓ Order.currency: field added',
      '✓ Query.orders(after): argument added',
      '✓ Status.REFUNDED: enum value added',
      '✗ NewOrder.qty: input field became required',
      '✗ Order.note: field removed',
      '✗ Order.total: field became nullable',
      '✗ Query.order(tenant): new required argument',
    ].sort());
  });

  it('Avro: new fields need defaults, types may only promote', () => {
    const before = JSON.stringify({type: 'record', name: 'Order', fields: [{name: 'id', type: 'string'}, {name: 'qty', type: 'int'}, {name: 'note', type: 'string'}, {name: 'status', type: {type: 'enum', name: 'Status', symbols: ['OPEN', 'PAID']}}]});
    const after = JSON.stringify({type: 'record', name: 'Order', fields: [{name: 'id', type: 'string'}, {name: 'qty', type: 'long'}, {name: 'currency', type: 'string'}, {name: 'region', type: 'string', default: 'eu'}, {name: 'status', type: {type: 'enum', name: 'Status', symbols: ['OPEN']}}]});
    expect(show(diffContract('avro', before, after))).toEqual([
      '✓ Order.note: field removed (old data still reads; readers that need it break)',
      '✗ Order.status: enum symbols removed: PAID',
      '✗ Order.currency: new field without a default: old data has no value for it',
      '✓ Order.region: field added with a default',
    ]);
    expect(formatChanges('order.avsc', diffContract('avro', before, before))).toBe('order.avsc: no contract changes');
  });
});

describe('contract changes on a branch and in a request', () => {
  it('compares each changed contract file with the branch base, new and deleted ones too', async () => {
    const {execFileSync} = await import('node:child_process');
    const {mkdtempSync, realpathSync, rmSync, writeFileSync} = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const {branchContracts, contractNote} = await import('../src/contracts/changes.js');
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-ct-')));
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: root});
    git('init', '-q');
    writeFileSync(path.join(root, 'order.proto'), 'message Order { string id = 1; int64 total = 2; }');
    writeFileSync(path.join(root, 'old.graphql'), 'type Q { a: Int }');
    writeFileSync(path.join(root, 'README.md'), 'x');
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(path.join(root, 'order.proto'), 'message Order { string id = 1; }');
    rmSync(path.join(root, 'old.graphql'));
    writeFileSync(path.join(root, 'events.avsc'), '{"type": "record", "name": "E", "fields": []}');
    writeFileSync(path.join(root, 'README.md'), 'y');
    const {base, files} = await branchContracts(root);
    expect(base).toBe('HEAD');
    expect(files.map((f) => [f.file, f.changes.map((c) => `${c.kind} ${c.what}`)])).toEqual([
      ['old.graphql', ['breaking contract file deleted']],
      ['order.proto', ['breaking field removed without reserving its number: a later field could reuse it']],
      ['events.avsc', ['safe new contract']],
    ]);
    expect(contractNote(files)).toMatch(/^Your change breaks API contracts[\s\S]*order\.proto: 1 breaking\n  ✗ Order\.total \(= 2\)[\s\S]*expand\/contract change/);
    expect(contractNote(files.filter((f) => f.file === 'events.avsc'))).toBeUndefined();
  });
});
