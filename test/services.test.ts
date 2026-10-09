import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {buildGraph, findServices, formatGraph, mermaid, neighbours} from '../src/system/services.js';
import {shop} from './system-fixture.js';

describe('service dependency graph', () => {
  it('finds the services and who calls whom, with the evidence', async () => {
    const root = shop();
    expect(findServices(root).map((s) => s.name).sort()).toEqual(['ledger', 'money', 'orders', 'search', 'web']);
    const g = await buildGraph(root);
    const edges = g.edges.map((e) => `${e.from} -> ${e.to} [${e.kind}]`).sort();
    expect(edges).toEqual([
      'orders -> ledger [compose]',
      'orders -> ledger [grpc]',
      'orders -> ledger [http]', // LEDGER_ADDR
      'orders -> money [package]',
      'web -> orders [http]',
      'web -> search [kubernetes]',
    ]);
    expect(g.services.find((s) => s.name === 'ledger')!.provides).toEqual(['grpc Ledger']);
    expect(g.edges.find((e) => e.kind === 'grpc')!.evidence).toMatch(/^services\/orders\/src\/ledger\.ts:2 \(Ledger client\)$/);
    expect(neighbours(g, 'orders').callers.map((e) => e.from)).toEqual(['web']);
    expect(formatGraph(g)).toMatch(/^5 services, 6 dependencies:/);
    expect(mermaid(g)).toContain('  web -->|http| orders');
  });

  it('has nothing to draw for a single service', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-one-')));
    expect(formatGraph(await buildGraph(root))).toMatch(/^Only one service here/);
  });
});
