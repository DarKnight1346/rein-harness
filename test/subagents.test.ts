import {describe, expect, it} from 'vitest';
import {MAX_CONTINUATIONS, SubagentManager, type Subagent} from '../src/agents/manager.js';
import type {ChatEvent, ProviderSession} from '../src/providers/types.js';
import {EventQueue} from '../src/util/proc.js';

function fakeSession(replies: (prompt: string) => ChatEvent[], prompts: string[]): ProviderSession {
  let interrupted = false;
  return {
    provider: 'claude',
    accountId: 'c1',
    model: 'haiku',
    nativeId: () => 'n1',
    send(prompt) {
      prompts.push(prompt);
      const q = new EventQueue<ChatEvent>();
      const evs = replies(prompt);
      // deliver asynchronously so cancel() can land mid-turn
      setTimeout(() => {
        for (const e of evs) q.push(interrupted ? {type: 'done', interrupted: true} : e);
        q.end();
      }, 20);
      return q;
    },
    interrupt() {
      interrupted = true;
    },
    async setModel() {},
    close() {},
  };
}

function manager(opts: {verdicts?: boolean[]; limit?: number; replies?: (p: string) => ChatEvent[]}) {
  const prompts: string[] = [];
  const finished: Subagent[] = [];
  const verdicts = [...(opts.verdicts ?? [])];
  const m = new SubagentManager({
    limit: () => opts.limit ?? 10,
    resolve: async () => ({ref: {provider: 'claude', model: 'haiku'}, accountId: 'c1', label: 'Haiku'}),
    open: async () => ({session: fakeSession(opts.replies ?? (() => [{type: 'text', delta: 'did it'}, {type: 'tokens', call: {input: 100, cached: 40, output: 10}}, {type: 'done', interrupted: false}]), prompts), ref: {provider: 'claude', model: 'haiku'}, accountId: 'c1', label: 'Haiku'}),
    bind: () => ({binding: {tools: [], call: async () => ({ok: true, text: ''}), listen: async () => '', proxy: {command: '', args: []}}, close() {}}),
    judge: async () => {
      const v = verdicts.length ? verdicts.shift()! : true;
      return {complete: v, note: v ? 'complete (0.9)' : 'not complete (0.2)'};
    },
    onActivity: () => () => {},
    finished: (a) => finished.push({...a}),
    killShells: () => {},
  });
  return {m, prompts, finished};
}

describe('SubagentManager', () => {
  it('runs a task, passes the completion check, keeps the session for follow-ups', async () => {
    const {m, prompts, finished} = manager({});
    const {agent, done} = m.spawn({task: 'write tests', mode: 'new', model: 'auto', name: 'tester'});
    const a = await done;
    expect([a.status, a.output, a.rounds, a.modelLabel]).toEqual(['done', 'did it', 1, 'Haiku']);
    expect(a.events.map((e) => e.kind)).toEqual(['text', 'check']);
    expect(a.tokens).toEqual({input: 100, cached: 40, output: 10});
    expect(prompts).toEqual(['write tests']);
    await m.message(agent.id, 'also add docs');
    expect(prompts.at(-1)).toBe('also add docs');
    expect(m.get(agent.id)!.events.map((e) => e.kind)).toContain('user');
    expect(finished.length).toBe(2);
  });

  it('makes the subagent continue when the decision model says it is not complete', async () => {
    const {m, prompts} = manager({verdicts: [false, false, true]});
    const a = await m.spawn({task: 'do it', mode: 'new', model: 'claude:haiku'}).done;
    expect(a.rounds).toBe(3);
    expect(prompts.slice(1).every((p) => /not finished yet/.test(p))).toBe(true);
    expect(a.events.filter((e) => e.kind === 'check').map((e: any) => e.complete)).toEqual([false, false, true]);
  });

  it('stops after the continuation cap', async () => {
    const {m} = manager({verdicts: Array(10).fill(false)});
    const a = await m.spawn({task: 'endless', mode: 'new', model: 'auto'}).done;
    expect(a.rounds).toBe(MAX_CONTINUATIONS + 1);
    expect(a.status).toBe('done');
  });

  it('enforces the concurrency limit and cancels', async () => {
    const {m} = manager({limit: 1});
    const first = m.spawn({task: 'a', mode: 'new', model: 'auto', background: true});
    expect(() => m.spawn({task: 'b', mode: 'new', model: 'auto'})).toThrow(/limit reached/);
    m.cancel(first.agent.id);
    expect((await first.done).status).toBe('cancelled');
    expect(m.running()).toHaveLength(0);
    expect(() => m.spawn({task: 'c', mode: 'new', model: 'auto'})).not.toThrow();
  });
});
