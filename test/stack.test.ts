import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {composeFile, composeServicesFor, formatServices, LocalStack, parsePs, servicesForChange, type Exec} from '../src/env/stack.js';

function repo() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-stack-')));
  for (const d of ['services/orders', 'services/web']) mkdirSync(path.join(root, d), {recursive: true});
  writeFileSync(path.join(root, 'compose.yaml'), 'services:\n  orders:\n    build: ./services/orders\n    depends_on: [db]\n  web:\n    build: {context: services/web}\n  db:\n    image: postgres:16\n');
  return root;
}
const PS = [
  {Service: 'orders', State: 'running', Health: 'healthy', Publishers: [{PublishedPort: 8080, TargetPort: 8080, Protocol: 'tcp'}]},
  {Service: 'db', State: 'running', Health: '', Publishers: [{PublishedPort: 0, TargetPort: 5432}]},
];

describe('multi-service local stack', () => {
  it('picks the compose services a change needs, by build context or name', () => {
    const root = repo();
    const f = composeFile(root)!;
    expect(composeServicesFor(f, [path.join(root, 'services/orders')])).toEqual(['orders']);
    expect(composeServicesFor(f, [path.join(root, 'services/web/src')])).toEqual(['web']);
  });

  it('reads compose ps in both formats', () => {
    const lines = PS.map((p) => JSON.stringify(p)).join('\n');
    expect(parsePs(lines)).toEqual([{name: 'orders', state: 'running', health: 'healthy', ports: ['localhost:8080 → 8080/tcp']}, {name: 'db', state: 'running', ports: []}]);
    expect(parsePs(JSON.stringify(PS))).toEqual(parsePs(lines));
    expect(formatServices(parsePs(lines))).toBe('  ✓ orders  running (healthy)  localhost:8080 → 8080/tcp\n  ✓ db  running');
  });

  it('brings services up and waits for health, and reports what is not ready', async () => {
    const root = repo();
    const calls: string[] = [];
    let ps = PS;
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' ').replace(root, '<root>'));
      if (args.includes('ps')) return {code: 0, stdout: ps.map((p) => JSON.stringify(p)).join('\n'), stderr: ''};
      return {code: 0, stdout: '', stderr: ''};
    };
    const stack = new LocalStack(root, exec, async () => {});
    const r = await stack.up(['orders']);
    expect(r).toMatchObject({ok: true, message: 'Up and healthy: orders, db.'});
    expect(calls[1]).toBe(`docker compose -f ${path.join('<root>', 'compose.yaml')} up -d --wait --wait-timeout 300 orders`);
    ps = [{...PS[0]!, Health: 'starting'}];
    expect((await stack.up(['orders'])).message).toBe('Not ready: orders (starting).');
  });

  it('only installs Helm charts into a local cluster', async () => {
    const root = repo();
    const ctx = (name: string): Exec => async (cmd) => ({code: 0, stdout: cmd === 'kubectl' ? `${name}\n` : '', stderr: ''});
    expect(await new LocalStack(root, ctx('prod-eu-1')).helm(path.join(root, 'charts/shop'))).toMatch(/^Refusing to install into prod-eu-1/);
    expect(await new LocalStack(root, ctx('kind-shop')).helm(path.join(root, 'charts/shop'))).toBe('Installed rein-shop into kind-shop.');
  });

  it('works out the services from the files the branch changes', async () => {
    const root = repo();
    const exec: Exec = async () => ({code: 0, stdout: 'services/web/src/app.ts\nREADME.md\n', stderr: ''});
    expect(await servicesForChange(root, [{name: 'orders', dir: path.join(root, 'services/orders'), provides: []}, {name: 'web', dir: path.join(root, 'services/web'), provides: []}], exec)).toEqual(['web']);
  });
});
