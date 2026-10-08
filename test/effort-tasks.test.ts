import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {catalog} from '../src/router/catalog.js';
import {makeRouter} from '../src/router/index.js';
import {makeAutoRouter} from '../src/router/auto.js';
import {clampEffort, Engine, type EngineEvent} from '../src/session/engine.js';
import {compactTranscript} from '../src/session/compactor.js';
import {newTranscript} from '../src/session/transcript.js';
import {DEFAULT_CONFIG, type Config} from '../src/store/config.js';
import {usageStore} from '../src/store/usage.js';
import {todoTool} from '../src/tools/todo.js';
import {acct, fakeAdapter, install, reply, tempHome} from './fakes.js';

let config: Config;
const collect = async (it: AsyncIterable<EngineEvent>) => {
  for await (const _ of it);
};
let log: ReturnType<typeof fakeAdapter>['log'];
let picks: string[];
const engine = (pick?: string) => {
  const router = makeRouter(() => config, makeAutoRouter({config: () => config}));
  return new Engine({config: () => config, route: router.route, alternative: router.alternative, compact: (t) => compactTranscript(t, config), pickEffort: async (_t, levels) => (picks.push(levels.join('/')), pick)});
};
beforeEach(async () => {
  vi.useFakeTimers({toFake: ['Date']});
  config = {...DEFAULT_CONFIG, chatModel: 'claude:sonnet'};
  usageStore.reset();
  catalog.authFailed.clear();
  picks = [];
  await tempHome([acct('claude', 'c1')]);
  const fake = fakeAdapter('claude', [{provider: 'claude', id: 'sonnet', label: 'Sonnet', tier: 3, contextWindow: 200_000, isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max']}], () => reply('ok'));
  log = fake.log;
  install('claude', fake.adapter);
  await catalog.refresh();
});
afterEach(() => vi.useRealTimers());

describe('effort', () => {
  it('a fixed level is passed to the session; unsupported levels clamp down', async () => {
    config.chatEffort = 'high';
    await collect(engine().send('hi'));
    expect(log.opened.at(-1)!.effort).toBe('high');
    expect(clampEffort('ultra', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max');
    expect(clampEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high');
  });

  it('"default" leaves it to the model', async () => {
    config.chatEffort = 'default';
    await collect(engine().send('hi'));
    expect(log.opened.at(-1)!.effort).toBeUndefined();
  });

  it('auto only lowers effort: low for a simple message, else the model default; only when the cache is cold', async () => {
    config.chatEffort = 'auto';
    const e = engine('low');
    await collect(e.send('one'));
    expect(log.opened.at(-1)!.effort).toBe('low');
    expect(picks).toEqual(['low/medium']); // never offered high/xhigh/max
    expect(log.opened).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await collect(e.send('two')); // warm: keeps its effort, no question, no new session
    expect(picks).toHaveLength(1);
    expect(log.opened).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await collect(e.send('three')); // cold: asks again
    expect(picks).toHaveLength(2);
  });

  it("auto leaves effort at the model's default when the message isn't simple", async () => {
    config.chatEffort = 'auto';
    const e = engine('medium');
    await collect(e.send('a hard one'));
    expect(log.opened.at(-1)!.effort).toBeUndefined();
  });

  it("Rein's own follow-ups keep the request's effort, even on a cold cache", async () => {
    config.chatEffort = 'auto';
    const e = engine('low');
    await collect(e.send('Implement the following feature exactly as specified.\n' + '- requirement\n'.repeat(300)));
    expect(log.opened.at(-1)!.effort).toBeUndefined(); // a spec: the model's default
    vi.setSystemTime(Date.now() + 61 * 60_000); // cold, like right after a compaction
    for (const follow of ['<context_compacted>\nContinue.\n</context_compacted>', '<code_check>\n1 problem\n</code_check>', '<stop_hook>\nKeep going.\n</stop_hook>']) {
      await collect(e.send(follow));
      expect(log.opened.at(-1)!.effort).toBeUndefined(); // not "simple, so low"
    }
    expect(picks).toEqual([]); // and the decision model wasn't asked
  });

  it('auto never lowers effort for a long message, and does not ask', async () => {
    config.chatEffort = 'auto';
    const e = engine('low');
    await collect(e.send('Implement the following feature exactly as specified.\n' + '- requirement\n'.repeat(300)));
    expect(log.opened.at(-1)!.effort).toBeUndefined();
    expect(picks).toEqual([]);
  });
});

describe('task list', () => {
  it('replaces the list on the conversation and reports progress', async () => {
    const t = newTranscript();
    let saved = 0;
    const tool = todoTool({transcript: () => t, changed: () => saved++});
    const res = await tool.run({root: '/'} as any, {
      todos: [
        {content: 'Write the parser', status: 'completed'},
        {content: 'Run the tests', status: 'in_progress', activeForm: 'Running the tests'},
        {content: 'Update the docs', status: 'pending'},
      ],
    });
    expect(t.todos).toHaveLength(3);
    expect(res.text).toContain('◐ Running the tests');
    expect(tool.summarize({todos: t.todos})).toBe('1/3 done');
    expect(saved).toBe(1);
    await expect(tool.run({root: '/'} as any, {todos: [{content: 'x', status: 'doing'}]})).rejects.toThrow(/status must be/);
  });
});
