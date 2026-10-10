import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {collectStats, formatStats, requestsOf} from '../src/insight/stats.js';
import {newTranscript, saveTranscript, type Transcript} from '../src/session/transcript.js';

let home: string;
const envHome = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_HOME = home;
});
afterEach(() => {
  if (envHome === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = envHome;
  rmSync(home, {recursive: true, force: true});
});

const t0 = Date.now() - 3_600_000;
const tool = (summary: string, ok: boolean) => ({label: 'Shell', summary, ok, result: ''});
function conversation(cwd: string): Transcript {
  const t = newTranscript();
  t.cwd = cwd;
  t.tokens = {uncached: 1000, cached: 0, output: 100, usd: 0.6};
  const opus = {provider: 'claude' as const, model: 'opus'};
  const codex = {provider: 'codex' as const, model: 'gpt-5.5'};
  t.messages = [
    {role: 'user', text: 'fix the failing test', at: t0},
    {role: 'assistant', text: 'trying', at: t0 + 30_000, model: opus, tools: [tool('$ npm test', false), {label: 'Edit', summary: 'src/a.ts', ok: true, result: ''}, tool('$ npm test', true)]},
    {role: 'user', text: '<code_check>2 problems</code_check>', at: t0 + 31_000, synthetic: true},
    {role: 'assistant', text: 'fixed', at: t0 + 90_000, model: opus},
    {role: 'user', text: 'now add a feature', at: t0 + 100_000},
    {role: 'assistant', text: 'done', at: t0 + 400_000, model: codex, tools: [{label: 'Edit', summary: 'src/b.ts', ok: true, result: ''}, tool('$ pytest -q', false)]},
    {role: 'user', text: 'explain it', at: t0 + 500_000},
    {role: 'assistant', text: '', at: t0 + 505_000, model: codex, interrupted: true},
  ];
  return t;
}

describe('/stats', () => {
  it('splits a conversation into requests, with retries, tests and a share of the cost', () => {
    const rs = requestsOf(conversation('/p'));
    expect(rs.map((r) => [r.ms, r.tools, r.failed, r.retries, r.tests, r.interrupted, r.model, Math.round(r.usd! * 100) / 100])).toEqual([
      [90_000, 3, 1, 1, 'passed', false, 'claude:opus', 0.2],
      [300_000, 2, 1, 0, 'failed', false, 'codex:gpt-5.5', 0.2],
      [5000, 0, 0, 0, undefined, true, 'codex:gpt-5.5', 0.2],
    ]);
  });

  it('adds up the project, or every project, over a window', async () => {
    await saveTranscript(conversation('/work/shop'));
    await saveTranscript(conversation('/work/other'));
    const here = await collectStats({cwd: '/work/shop', days: 30});
    expect([here.conversations, here.requests.length]).toEqual([1, 3]);
    expect((await collectStats({days: 30})).requests).toHaveLength(6);
    const text = formatStats(here, 30);
    expect(text).toMatch(/^Last 30 days, shop: 1 conversation, 3 requests\n  time per request   median 2 min · longest 5 min\n  tool calls         5 \(1\.7 a request\) · 40% failed · 1 retry of a failed call\n  tests at the end   passed in 1 of 2 requests that ran tests \(50%\)\n  interrupted        1 request\n  cost               \$0\.60 at API list prices/);
    expect(text).toMatch(/By model:\n  codex:gpt-5\.5 +2 requests[\s\S]*\n  claude:opus +1 request, median 2 min, 3\.0 tool calls each, tests passed at the end 100%/);
    expect(formatStats(await collectStats({cwd: '/nowhere', days: 7}), 7)).toBe('No requests in the last 7 days (nowhere).');
  });
});
