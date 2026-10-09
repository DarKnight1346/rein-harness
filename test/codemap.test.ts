import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {annotateTask, codemapDir, codemapStatus, writeCodemap} from '../src/system/codemap.js';
import {buildGraph} from '../src/system/services.js';
import {shop} from './system-fixture.js';

describe('codemaps', () => {
  it('writes an index and a page per service, keeps notes, and says what is stale', async () => {
    const root = shop();
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {cwd: root});
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'base');
    const g = await buildGraph(root);
    const first = await writeCodemap(root, g);
    expect(first.written.sort()).toEqual(['ledger', 'money', 'orders', 'search', 'web']);
    const index = readFileSync(path.join(codemapDir(root), 'README.md'), 'utf8');
    expect(index).toContain('```mermaid\ngraph LR');
    expect(index).toContain('| [orders](orders.md) | http openapi.yaml | ledger, money | web |');
    const orders = path.join(codemapDir(root), 'orders.md');
    expect(readFileSync(orders, 'utf8')).toMatch(/^# orders\n\n`services\/orders`\n\n## Notes\n\n<!-- rein:notes -->\n_What this service is for[\s\S]*## Calls\n\n- \[ledger\]\(ledger\.md\) \(compose\)/);
    expect((await codemapStatus(root, g)).unannotated.sort()).toEqual(['ledger', 'money', 'orders', 'search', 'web']);

    writeFileSync(orders, readFileSync(orders, 'utf8').replace(/<!-- rein:notes -->[\s\S]*<!-- \/rein:notes -->/, '<!-- rein:notes -->\nTakes orders and posts them to the ledger.\n<!-- /rein:notes -->'));
    writeFileSync(path.join(root, 'services/orders/src/new.ts'), 'export const x = 1;\n');
    git('add', '.');
    expect((await codemapStatus(root, g)).stale).toEqual(['orders']);
    const second = await writeCodemap(root, g);
    expect(second.written).toEqual(['orders']);
    expect(readFileSync(orders, 'utf8')).toContain('<!-- rein:notes -->\nTakes orders and posts them to the ledger.\n<!-- /rein:notes -->');
    expect((await codemapStatus(root, g)).unannotated).not.toContain('orders');
    expect(annotateTask(root, ['web'])).toMatch(/Notes section of these codemap pages in .*docs\/codemap\/: web\.md/);
  }, 30_000); // git, the repo map and owners for five services, twice
});
