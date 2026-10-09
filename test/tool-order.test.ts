import {mkdtempSync, readFileSync, realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ToolHost} from '../src/tools/host.js';

let root: string;
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_CLAUDE_SETTINGS = path.join(process.env.REIN_HOME, 'none.json');
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-proj-')));
});
afterEach(() => vi.restoreAllMocks());

const host = (experiments: string[] = []) => new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => experiments});

describe('calls from one response', () => {
  it('run in the order the model made them, even when they arrive at once', async () => {
    const h = host();
    const results = await Promise.all([
      h.callInOrder('write', {path: 'a.txt', content: 'one\n'}),
      h.callInOrder('read', {path: 'a.txt'}),
      h.callInOrder('edit', {path: 'a.txt', old_string: 'one', new_string: 'two'}),
      h.callInOrder('read', {path: 'a.txt'}),
      h.callInOrder('shell', {command: 'echo three > a.txt'}),
      h.callInOrder('read', {path: 'a.txt'}),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, true]);
    expect(results[1]!.text).toMatch(/one/);
    expect(results[3]!.text).toMatch(/two/);
    expect(results[5]!.text).toMatch(/three/);
  });

  it('many-calls: a model making one call per response is reminded to batch, less often each time', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 5_000)); // every call a new response
    const h = host(['many-calls']);
    const nudged: number[] = [];
    for (let i = 0; i < 20; i++) if ((await h.callInOrder('list', {path: '.'})).text.includes('single tool call')) nudged.push(i);
    expect(nudged).toEqual([4, 12]); // the 5th call, after 4 single-call responses; then after 8 more
    expect((await host().callInOrder('list', {path: '.'})).text).not.toMatch(/single tool call/);
  });
});

describe('shell-cap', () => {
  it('keeps the head and tail of a long output and saves the rest to the scratchpad', async () => {
    const scratch = path.join(root, '.scratch');
    const h = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', experiments: () => ['shell-cap'], scratch: () => scratch});
    const r = await h.call('shell', {command: 'seq 1 20000'});
    expect(r.text.length).toBeLessThan(8_000);
    expect(r.text).toMatch(/\n1\n2\n/);
    expect(r.text).toMatch(/\n20000/);
    const file = /The output is saved in (\S+):/.exec(r.text)?.[1];
    expect(readFileSync(file!, 'utf8')).toMatch(/\n150\n[\s\S]*\n19000\n/); // its first lines and its last ones
    expect((await h.call('shell', {command: 'seq 1 10'})).text).not.toMatch(/left out/);
  });
});
