import {describe, expect, it} from 'vitest';
import {contextReport} from '../src/session/context.js';

describe('/context during a long turn', () => {
  it("counts the turn in progress: its tool results and the live request size", async () => {
    const engine: any = {
      transcript: {id: 't', messages: [{role: 'user', text: 'Build an OS', at: 0}]},
      current: undefined,
      lastUsage: {ref: {provider: 'claude', model: 'x'}, input: 90_000, output: 0, at: 0},
      inFlight: {reply: 'Checking the toolchain…', tools: [{label: 'Shell', summary: '$ brew info qemu', ok: true, result: 'q'.repeat(8000)}]},
    };
    const r = await contextReport(engine, {chatModel: 'claude:x', autoCompactPct: 50} as any, []);
    const by = Object.fromEntries(r.categories.map((c) => [c.key, c.tokens]));
    expect(by.calls).toBeGreaterThanOrEqual(2000); // the shell output, before the turn has ended
    expect(r.measured).toBe(90_000);
    expect(r.used).toBe(90_000);
  });

  it('lists the largest items, so you can tell what to drop', async () => {
    const engine: any = {
      transcript: {id: 't', messages: [{role: 'user', text: 'Fix the build', at: 0, tools: [
        {label: 'Read', summary: 'src/huge.ts', ok: true, result: 'x'.repeat(40_000)},
        {label: 'Shell', summary: '$ npm test', ok: true, result: 'y'.repeat(4000)},
        {label: 'List', summary: '.', ok: true, result: 'a b'},
      ]}]},
      current: undefined,
      lastUsage: undefined,
      inFlight: undefined,
    };
    const r = await contextReport(engine, {chatModel: 'claude:x', autoCompactPct: 50} as any, []);
    const tools = r.largest!.filter((i) => !i.what.startsWith('instructions '));
    expect(tools.map((i) => i.what)).toEqual(['Read(src/huge.ts)', 'Shell($ npm test)']); // tiny results left out
    expect(tools[0]!.tokens).toBeGreaterThan(tools[1]!.tokens);
  });
});
