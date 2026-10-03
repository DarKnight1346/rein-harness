import {describe, expect, it} from 'vitest';
import type {Subagent} from '../src/agents/manager.js';
import {subagentContextReport, subagentConversation} from '../src/session/context.js';

const agent = (over: Partial<Subagent> = {}): Subagent => ({
  id: 2, name: 'scout', task: 'Map the billing module', mode: 'new', requested: 'auto', background: true, status: 'running', startedAt: Date.now(), output: '', rounds: 1,
  events: [
    {kind: 'text', text: 'Looking at billing.'},
    {kind: 'tool', id: 1, label: 'Read', summary: 'billing.ts', ok: true, result: 'x'.repeat(4000)},
    {kind: 'user', text: 'also check invoices'},
  ],
  tokens: {input: 0, cached: 0, output: 0},
  ...over,
});

describe('commands scoped to the viewed subagent', () => {
  it("/context reports the subagent's own conversation, not the main agent's", async () => {
    const r = await subagentContextReport(agent({lastInput: 30_000}), {} as any, []);
    const by = Object.fromEntries(r.categories.map((c) => [c.key, c.tokens]));
    expect(by.calls).toBeGreaterThanOrEqual(1000); // the 4,000-char read result
    expect(by.messages).toBeGreaterThan(0);
    expect(r.measured).toBe(30_000);
    expect(r.used).toBe(30_000);
    expect(r.categories.at(-1)?.key).toBe('other');
    expect(r.messageCount).toBe(3); // task + reply + user message
  });

  it('a fork labels the unexplained part as inherited from the parent', async () => {
    const r = await subagentContextReport(agent({mode: 'fork', lastInput: 80_000}), {} as any, []);
    expect(r.categories.at(-1)?.label).toMatch(/Inherited from the parent/);
  });

  it("/btw sees the subagent's task, replies, the user's messages and tool calls", () => {
    const c = subagentConversation(agent());
    expect(c.messages).toContain('[task]\nMap the billing module');
    expect(c.messages).toContain('[user]\nalso check invoices');
    expect(c.calls).toContain('Read billing.ts');
  });
});
