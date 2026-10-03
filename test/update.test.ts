import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {runUpdate, type UpdateLine} from '../src/commands/update.js';
import {acct, tempHome} from './fakes.js';

beforeAll(async () => {
  process.env.REIN_CLAUDE_BIN = path.resolve('test/fixtures/fake-claude.mjs');
  process.env.REIN_CODEX_BIN = path.resolve('test/fixtures/fake-codex.mjs');
  // Self-update looks at a throwaway folder, never this checkout (it would git pull / npm install).
  process.env.REIN_INSTALL_ROOT = mkdtempSync(path.join(os.tmpdir(), 'rein-install-'));
  const home = await tempHome([{...acct('codex', 'x1'), home: '/tmp/rein-fake-codex-home', imported: false}]);
  void home;
});

describe('/update', () => {
  it('updates both CLIs, checks the Codex protocol, and reports self-update status', async () => {
    let closed = 0;
    const lines: UpdateLine[] = [];
    for await (const l of runUpdate(() => closed++)) lines.push(l);
    const text = lines.map((l) => `${l.level ?? '-'} ${l.text}`).join('\n');
    expect(closed).toBe(1);
    expect(text).toMatch(/Current: claude 2\.1\.288 · codex 0\.160\.0/);
    expect(text).toContain('info claude update');
    expect(text).toContain('output Claude Code is up to date');
    expect(text).toContain('info codex update');
    expect(text).toMatch(/ok Codex app-server protocol OK \(1 models\)/);
    expect(text).toMatch(/rein .*(without a remote|no update source|up to date)/i);
  });

  it('warns when codex is outside the tested range', async () => {
    process.env.FAKE_CODEX_VERSION = '0.170.1';
    const lines: UpdateLine[] = [];
    for await (const l of runUpdate(() => {})) lines.push(l);
    delete process.env.FAKE_CODEX_VERSION;
    expect(lines.some((l) => l.level === 'warn' && /tested 0\.160/.test(l.text))).toBe(true);
  });
});
