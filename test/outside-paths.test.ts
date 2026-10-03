import {mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {isSensitivePath, ToolHost, type ApprovalDecision, type ApprovalMode, type ApprovalRequest} from '../src/tools/host.js';

function setup(mode: ApprovalMode, answer: ApprovalDecision) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rein-proj-'));
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-elsewhere-')));
  writeFileSync(path.join(outside, 'notes.txt'), 'hello from outside\n');
  const asked: ApprovalRequest[] = [];
  const host = new ToolHost({root, mode: () => mode, approve: async (r) => (asked.push(r), answer)});
  return {root, outside, asked, host};
}

describe('paths outside the project', () => {
  it('reads outside ask first; denied → not read', async () => {
    const {outside, asked, host} = setup('ask', 'deny');
    const res = await host.call('read', {path: path.join(outside, 'notes.txt')});
    expect(res.ok).toBe(false);
    expect(res.text).toMatch(/denied access/);
    expect(asked[0]?.outside).toEqual([path.join(outside, 'notes.txt')]);
  });

  it('allowed once → read works; asked again next time', async () => {
    const {outside, asked, host} = setup('ask', 'once');
    expect((await host.call('read', {path: path.join(outside, 'notes.txt')})).text).toContain('hello from outside');
    await host.call('read', {path: path.join(outside, 'notes.txt')});
    expect(asked).toHaveLength(2);
  });

  it('"allow reads outside this session" stops asking for reads, not writes', async () => {
    const {outside, asked, host} = setup('ask', 'session');
    await host.call('read', {path: path.join(outside, 'notes.txt')});
    await host.call('list', {path: outside});
    expect(asked).toHaveLength(1);
    await host.call('write', {path: path.join(outside, 'new.txt'), content: 'x'});
    expect(asked).toHaveLength(2); // writes outside always need their own yes
  });

  it('allowing a write outside for the session adds that folder as a working directory', async () => {
    const {outside, host} = setup('ask', 'session');
    await host.call('write', {path: path.join(outside, 'a.txt'), content: 'one'});
    expect(host.workingDirs()).toContain(outside);
    expect(readFileSync(path.join(outside, 'a.txt'), 'utf8')).toBe('one');
  });

  it('~/ paths resolve to the home folder', async () => {
    const {asked, host} = setup('ask', 'deny');
    await host.call('list', {path: '~/'});
    expect(asked[0]?.outside).toEqual([realpathSync(os.homedir())]);
  });

  it('/add-dir directories need no approval for reads', async () => {
    const {outside, asked, host} = setup('ask', 'deny');
    host.addDirs([outside]);
    expect((await host.call('read', {path: path.join(outside, 'notes.txt')})).text).toContain('hello from outside');
    expect(asked).toHaveLength(0);
  });

  it('bypass mode allows outside paths, but credentials still ask (once only)', async () => {
    const {outside, asked, host} = setup('bypass', 'deny');
    expect((await host.call('read', {path: path.join(outside, 'notes.txt')})).ok).toBe(true);
    expect(asked).toHaveLength(0);
    const ssh = path.join(os.homedir(), '.ssh', 'id_ed25519');
    expect(isSensitivePath(ssh)).toBe(true);
    const res = await host.call('read', {path: '~/.ssh/id_ed25519'});
    expect(res.ok).toBe(false);
    expect(asked[0]?.sensitive).toBe(true);
  });

  it('flags credential locations and secret files as sensitive', () => {
    const h = os.homedir();
    for (const p of ['.aws/credentials', '.codex/auth.json', '.claude/.credentials.json', '.rein/accounts/claude/x/y', '.npmrc']) expect(isSensitivePath(path.join(h, p))).toBe(true);
    expect(isSensitivePath('/srv/app/.env.production')).toBe(true);
    expect(isSensitivePath('/srv/app/server.key')).toBe(true);
    expect(isSensitivePath(path.join(h, 'Desktop/notes.md'))).toBe(false);
  });

  it('a project symlink pointing outside counts as outside', async () => {
    const {root, outside, asked, host} = setup('ask', 'deny');
    mkdirSync(path.join(root, 'sub'));
    const {symlinkSync} = await import('node:fs');
    symlinkSync(outside, path.join(root, 'sub', 'link'));
    expect((await host.call('read', {path: 'sub/link/notes.txt'})).ok).toBe(false);
    expect(asked[0]?.outside?.[0]).toBe(path.join(outside, 'notes.txt'));
  });
});
