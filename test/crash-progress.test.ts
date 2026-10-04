import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {loadTranscript, newTranscript, recordProgress, saveTranscript, truncateTranscript} from '../src/session/transcript.js';

beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-crash-'));
});
const tool = (n: number) => ({label: 'Edit', summary: `src/f${n}.ts`, ok: true, result: `edited ${n}`});

describe('turn progress (crash safety)', () => {
  it("rebuilds a turn Rein didn't finish from its progress records", async () => {
    const t = newTranscript();
    t.messages.push({role: 'user', text: 'refactor the scheduler', at: 1});
    await recordProgress(t, 1, {tool: tool(1), text: 'Starting with the run queue. ', model: {provider: 'claude', model: 'opus'}, accountId: 'c1'});
    await recordProgress(t, 1, {tool: tool(2), text: 'Now the timer. '});
    // …and Rein dies here: no assistant message was ever saved.
    const loaded = (await loadTranscript(t.id))!;
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[1]).toMatchObject({role: 'assistant', text: 'Starting with the run queue. Now the timer. ', cutOff: true, interrupted: true, accountId: 'c1', model: {model: 'opus'}});
    expect(loaded.messages[1]!.tools!.map((x) => x.summary)).toEqual(['src/f1.ts', 'src/f2.ts']);
  });

  it('ignores progress once the finished reply is saved', async () => {
    const t = newTranscript();
    t.messages.push({role: 'user', text: 'hi', at: 1});
    await recordProgress(t, 1, {tool: tool(1)});
    t.messages.push({role: 'assistant', text: 'done', at: 2, tools: [tool(1)]});
    await saveTranscript(t);
    const loaded = (await loadTranscript(t.id))!;
    expect(loaded.messages.map((m) => [m.role, m.text, !!m.cutOff])).toEqual([['user', 'hi', false], ['assistant', 'done', false]]);
  });

  it('drops progress of rewound turns', async () => {
    const t = newTranscript();
    t.messages.push({role: 'user', text: 'one', at: 1}, {role: 'assistant', text: 'ok', at: 2}, {role: 'user', text: 'two', at: 3});
    await saveTranscript(t);
    await recordProgress(t, 3, {tool: tool(1)});
    await truncateTranscript(t, 2);
    const loaded = (await loadTranscript(t.id))!;
    expect(loaded.messages.map((m) => m.text)).toEqual(['one', 'ok']);
  });
});
