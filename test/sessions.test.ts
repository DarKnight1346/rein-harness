import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {listTranscripts, loadTranscript, newTranscript, saveTranscript, scratchDir} from '../src/session/transcript.js';
import {sessionRead, sessionsSearch} from '../src/tools/sessions.js';
import {ToolHost} from '../src/tools/host.js';

let proj: string;
beforeEach(async () => {
  process.env.REIN_HOME = await mkdtemp(path.join(os.tmpdir(), 'rein-home-'));
  proj = await mkdtemp(path.join(os.tmpdir(), 'rein-proj-'));
});

async function saved(cwd: string, msgs: [string, string][], tools?: any[]) {
  const t = newTranscript();
  t.cwd = cwd;
  msgs.forEach(([role, text], i) => t.messages.push({role: role as any, text, at: Date.now() + i, ...(role === 'assistant' && tools ? {tools} : {})}));
  await saveTranscript(t);
  return t;
}

describe('saved sessions', () => {
  it('lists per project, newest first, and loads by id', async () => {
    const a = await saved(proj, [['user', 'fix the login bug'], ['assistant', 'done']]);
    await new Promise((r) => setTimeout(r, 5));
    const b = await saved(proj, [['user', 'add dark mode'], ['assistant', 'ok']]);
    await saved('/somewhere/else', [['user', 'other project'], ['assistant', 'x']]);
    const list = await listTranscripts({cwd: proj});
    expect(list.map((s) => s.title)).toEqual(['add dark mode', 'fix the login bug']);
    expect((await loadTranscript(a.id))?.messages[0]?.text).toBe('fix the login bug');
    expect(await loadTranscript('../../etc')).toBeUndefined();
    void b;
  });

  it('search covers messages and tool calls; read pages through a session', async () => {
    const t = await saved(proj, [['user', 'deploy please'], ['assistant', 'Deployed.']], [{label: 'Shell', summary: '$ ./deploy.sh staging-eu-2', ok: true, result: 'deployed to staging-eu-2'}]);
    await saved('/elsewhere', [['user', 'staging-eu-2 elsewhere'], ['assistant', 'x']]);
    const local = await sessionsSearch({root: proj, sessionId: t.id}, {pattern: 'staging-eu-2'});
    expect(local.text).toContain(`${t.id} (current)`);
    expect(local.text).toContain('#1 assistant');
    expect(local.text).not.toContain('elsewhere');
    expect((await sessionsSearch({root: proj}, {pattern: 'staging-eu-2', all_projects: true})).text).toContain('elsewhere');
    const read = await sessionRead({root: proj}, {id: t.id});
    expect(read.text).toContain('[Shell($ ./deploy.sh staging-eu-2) ✓] deployed to staging-eu-2');
  });
});

describe('scratchpad', () => {
  it('is usable by file tools without approval; the project still asks', async () => {
    const t = newTranscript();
    const scratch = scratchDir(t.id);
    const asked: string[] = [];
    const host = new ToolHost({root: proj, mode: () => 'ask', scratch: () => scratch, approve: async (r) => (asked.push(r.summary), 'deny')});
    const w = await host.call('write', {path: path.join(scratch, 'notes.md'), content: 'draft'});
    expect(w.ok).toBe(true);
    expect(await readFile(path.join(scratch, 'notes.md'), 'utf8')).toBe('draft');
    expect((await host.call('write', {path: 'x.txt', content: 'x'})).ok).toBe(false); // project: asked, denied
    expect(asked).toEqual(['x.txt']);
    expect(existsSync(path.join(proj, 'x.txt'))).toBe(false);
    expect((await host.call('read', {path: path.join(os.tmpdir(), 'nope.txt')})).text).toMatch(/outside the project/);
    host.close();
  });
});

describe('JSONL storage', () => {
  it('appends only new lines, folds meta, migrates legacy json', async () => {
    const {sessionLog} = await import('../src/session/transcript.js');
    const {stat, writeFile: wf, mkdir: mk} = await import('node:fs/promises');
    const t = newTranscript();
    t.cwd = proj;
    t.messages.push({role: 'user', text: 'hello', at: 1});
    await saveTranscript(t);
    const size1 = (await stat(sessionLog(t.id))).size;
    t.messages.push({role: 'assistant', text: 'hi', at: 2});
    t.summary = {text: 'S', coversUpTo: 1};
    await saveTranscript(t);
    await saveTranscript(t); // nothing new → nothing written
    const raw = await readFile(sessionLog(t.id), 'utf8');
    expect(raw.split('\n').filter(Boolean).map((l) => JSON.parse(l).t)).toEqual(['msg', 'meta', 'msg', 'meta']);
    expect((await stat(sessionLog(t.id))).size).toBeGreaterThan(size1);
    const back = await loadTranscript(t.id);
    expect(back?.messages.map((m) => m.text)).toEqual(['hello', 'hi']);
    expect(back?.summary).toEqual({text: 'S', coversUpTo: 1});
    // legacy
    const dir = path.join(process.env.REIN_HOME!, 'sessions');
    await mk(dir, {recursive: true});
    await wf(path.join(dir, 'old-session.json'), JSON.stringify({id: 'old-session', createdAt: 5, cwd: proj, native: {}, messages: [{role: 'user', text: 'legacy question', at: 5}]}));
    const list = await listTranscripts({cwd: proj});
    expect(list.map((s) => s.title)).toContain('legacy question');
    expect(existsSync(path.join(dir, 'old-session.json'))).toBe(false);
    expect((await loadTranscript('old-session'))?.messages[0]?.text).toBe('legacy question');
  });

  it('searches and pages a large (~50 MB) conversation quickly', async () => {
    const t = newTranscript();
    t.cwd = proj;
    const filler = 'lorem ipsum dolor sit amet '.repeat(40);
    for (let i = 0; i < 45_000; i++) t.messages.push({role: i % 2 ? 'assistant' : 'user', text: `${i} ${filler}`, at: i});
    t.messages[40_123]!.text = 'the secret rollout flag is ZEBRA-42';
    await saveTranscript(t);
    const {stat} = await import('node:fs/promises');
    const {sessionLog} = await import('../src/session/transcript.js');
    expect((await stat(sessionLog(t.id))).size).toBeGreaterThan(45 * 1024 * 1024);
    let t0 = Date.now();
    const found = await sessionsSearch({root: proj}, {pattern: 'ZEBRA-\\d+'});
    const searchMs = Date.now() - t0;
    expect(found.text).toContain('#40123');
    t0 = Date.now();
    const page = await sessionRead({root: proj}, {id: t.id, offset: 10, limit: 2});
    const readMs = Date.now() - t0;
    expect(page.text).toContain('#10 user');
    expect(page.text).toContain('#11 assistant');
    expect(page.text).toContain('more (offset=12)');
    console.log(`50MB session: search ${searchMs}ms, read page ${readMs}ms`);
    expect(searchMs).toBeLessThan(3000);
    expect(readMs).toBeLessThan(500);
  }, 60_000);
});
