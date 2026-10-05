import {beforeEach, describe, expect, it} from 'vitest';
import {catalog} from '../src/router/catalog.js';
import {compactTranscript, summaryMap} from '../src/session/compactor.js';
import {buildCarry, newTranscript, type Message} from '../src/session/transcript.js';
import {DEFAULT_CONFIG} from '../src/store/config.js';
import {usageStore} from '../src/store/usage.js';
import {recallTool} from '../src/tools/recall.js';
import {acct, CLAUDE_FAKE_MODELS, fakeAdapter, install, reply, tempHome} from './fakes.js';

const msgs = (): Message[] => [
  {role: 'user', text: 'Fix the date parser in src/date.ts', at: 1},
  {role: 'assistant', text: 'Fixed: the parser now handles ISO weeks.', at: 2, tools: [{label: 'Edit', summary: 'src/date.ts', ok: true, result: 'Edited src/date.ts: 1 replacement'}, {label: 'Shell', summary: 'npm test', ok: true, result: 'Error: ETIMEDOUT reading cache\n128 passed'}]},
  {role: 'user', text: 'Now add a CLI flag --week', at: 3},
  {role: 'assistant', text: 'Added --week.', at: 4, tools: [{label: 'Write', summary: 'src/cli.ts', ok: true, result: 'Wrote src/cli.ts'}]},
  {role: 'user', text: 'Thanks. What next?', at: 5},
  {role: 'assistant', text: 'Docs.', at: 6},
];

beforeEach(() => {
  usageStore.reset();
});

describe('compaction keeps a map of what it summarized', () => {
  it('lists each part you asked for, with the files it changed', () => {
    const map = summaryMap(msgs(), 4)!;
    expect(map).toContain('#1-2 "Fix the date parser in src/date.ts" · changed src/date.ts');
    expect(map).toContain('#3-4 "Now add a CLI flag --week" · changed src/cli.ts');
    expect(map).not.toContain('Thanks'); // not summarized
    expect(map).toMatch(/restore one with recall/);
  });

  it('focus instructions reach the compaction model; the map goes to the next session', async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('ok'), () => 'GOAL: dates.');
    install('claude', adapter);
    await catalog.refresh();
    const t = newTranscript();
    t.messages = msgs();
    const res = await compactTranscript(t, {...DEFAULT_CONFIG, compactionModel: 'cheapest'}, {keepRecent: 2, focus: 'the ISO week handling'});
    expect('skipped' in res).toBe(false);
    expect(log.oneShots.at(-1)!.system).toContain('focus on: the ISO week handling');
    expect(t.summary).toMatchObject({text: 'GOAL: dates.', coversUpTo: 4});
    const {readFileSync} = await import('node:fs');
    const {scratchDir} = await import('../src/session/transcript.js');
    expect(readFileSync(`${scratchDir(t.id)}/summary.md`, 'utf8')).toContain('#3-4 "Now add a CLI flag --week"');
    const carry = buildCarry(t, 0, t.messages.length, 100_000).text;
    expect(carry).toContain('GOAL: dates.');
    expect(carry).toContain('#1-2 "Fix the date parser');
  });
});

describe('recall', () => {
  const t = newTranscript();
  t.messages = msgs();
  t.summary = {text: 'GOAL: dates.', coversUpTo: 4, map: summaryMap(msgs(), 4)};
  const recall = recallTool(() => t);
  it('brings back summarized messages verbatim, tool results in full', async () => {
    const r = await recall.run({} as any, {from: 1, to: 2});
    expect(r.text).toContain('Fix the date parser');
    expect(r.text).toContain('Error: ETIMEDOUT reading cache'); // the full result, not just "✓"
  });
  it('finds where something was said', async () => {
    const r = await recall.run({} as any, {query: 'etimedout'});
    expect(r.text).toMatch(/#2 \(assistant\): .*ETIMEDOUT/);
  });
  it("says so for parts that weren't summarized", async () => {
    expect((await recall.run({} as any, {from: 5, to: 6})).text).toMatch(/still in your context/);
    expect((await recallTool(() => newTranscript()).run({} as any, {from: 1})).text).toMatch(/Nothing has been summarized/);
  });
});
