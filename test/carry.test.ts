import {describe, expect, it} from 'vitest';
import {carriedTools, parseIndices, selectCarriedTools, toolIndex} from '../src/session/carry.js';
import {buildCarry, newTranscript, type Transcript} from '../src/session/transcript.js';

function convo(results: string[]): Transcript {
  const t = newTranscript();
  t.messages.push({role: 'user', text: 'fix the bug', at: 1});
  t.messages.push({role: 'assistant', text: 'Done.', at: 2, tools: results.map((r, i) => ({label: i % 2 ? 'Edit' : 'Read', summary: `src/f${i}.ts`, ok: true, result: r}))});
  t.messages.push({role: 'user', text: 'now run the tests', at: 3});
  return t;
}

describe('context carry', () => {
  it('small tool results all travel with the conversation', async () => {
    const t = convo(['const a = 1;', 'Edited src/f1.ts']);
    const tools = carriedTools(t, 0, 2);
    const picked = await selectCarriedTools(tools, 'now run the tests');
    expect(picked.how).toBe('all');
    const {text} = buildCarry(t, 0, 2, 24_000, picked.keys);
    expect(text).toContain('[tool Read(src/f0.ts) result:\nconst a = 1;');
    expect(text).toContain('User: fix the bug');
  });

  it('big results: the selector picks, the rest become one-line traces', async () => {
    const big = (tag: string) => `${tag}\n${'x'.repeat(30_000)}`;
    const t = convo([big('OLD READ'), big('EDIT OUT'), big('LATEST READ')]);
    const tools = carriedTools(t, 0, 2);
    let seen = '';
    const picked = await selectCarriedTools(tools, 'now run the tests', async ({index}) => ((seen = index), [2]), 12_000);
    expect(picked.how).toBe('selected');
    expect(seen).toContain('#0 Read(src/f0.ts) ok');
    expect(seen).not.toContain('xxxxxxxxxx'.repeat(20)); // the selector never sees full results
    const {text} = buildCarry(t, 0, 2, 24_000, picked.keys);
    expect(text).toContain('LATEST READ');
    expect(text).not.toContain('OLD READ');
    expect(text).toContain('[tool Read(src/f0.ts) ✓]');
  });

  it('without a working selector, keeps the most recent results that fit', async () => {
    const t = convo(['a'.repeat(30_000), 'b'.repeat(30_000), 'c'.repeat(30_000)]);
    const picked = await selectCarriedTools(carriedTools(t, 0, 2), 'go', async () => {
      throw new Error('model down');
    }, 9_000);
    expect(picked.how).toBe('recent');
    expect([...picked.keys]).toEqual(['1:2']);
  });

  it('parses the selector reply leniently', () => {
    expect(parseIndices('Keep these: [3, 0, 7].')).toEqual([3, 0, 7]);
    expect(parseIndices('none')).toEqual([]);
    expect(toolIndex([])).toBe('');
  });
});
