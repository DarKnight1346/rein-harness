import {beforeEach, describe, expect, it} from 'vitest';
import {cacheTurns, formatCache} from '../src/insight/cache.js';
import {catalog} from '../src/router/catalog.js';
import {makeRouter} from '../src/router/index.js';
import {makeAutoRouter} from '../src/router/auto.js';
import {Engine, type EngineEvent} from '../src/session/engine.js';
import {compactTranscript} from '../src/session/compactor.js';
import {DEFAULT_CONFIG, type Config} from '../src/store/config.js';
import {usageStore} from '../src/store/usage.js';
import {acct, CLAUDE_FAKE_MODELS, fakeAdapter, install, tempHome} from './fakes.js';

const drain = async (it: AsyncIterable<EngineEvent>) => {
  for await (const _ of it);
};

describe('prompt-cache analytics', () => {
  let config: Config;
  beforeEach(() => {
    config = {...DEFAULT_CONFIG, chatModel: 'claude:sonnet', experiments: []};
    usageStore.reset();
  });

  it('records each turn’s cache use, and why it was cold', async () => {
    await tempHome([acct('claude', 'c1')]);
    let turn = 0;
    const {adapter} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => {
      turn++;
      return [{type: 'tokens', call: {input: 1000, cached: turn === 2 ? 900 : 0, output: 50}}, {type: 'text', delta: `reply ${turn}`}, {type: 'done', interrupted: false}];
    });
    install('claude', adapter);
    await catalog.refresh();
    const router = makeRouter(() => config, makeAutoRouter({config: () => config}));
    const engine = new Engine({config: () => config, route: router.route, alternative: router.alternative, compact: (t) => compactTranscript(t, config)});
    await drain(engine.send('one'));
    await drain(engine.send('two'));
    expect(engine.transcript.messages[3]!.cache).toEqual({input: 1000, cached: 900}); // warm: no reason
    await engine.rewind(2);
    await drain(engine.send('two again'));
    expect(engine.transcript.messages.filter((m) => m.role === 'assistant').map((m) => m.cache)).toEqual([
      {input: 1000, cached: 0, cold: 'first message'},
      {input: 1000, cached: 0, cold: 'rewound'},
    ]);
    const turns = cacheTurns(engine.transcript);
    const text = formatCache(turns, 30, 'shop');
    expect(text).toMatch(/^Prompt cache, last 30 days \(shop\): 0% of 2K input tokens read from the cache, over 2 turns/);
    expect(text).toMatch(/What made it cold \(turns, input tokens not cached\):\n  (first message|rewound) +1 turns +1K\n  (first message|rewound) +1 turns +1K$/);
  });

  it('groups idle gaps, flags unexplained misses, and says when there is no data', () => {
    const base = {conversation: 'c', at: 1, model: 'claude:opus'};
    const text = formatCache([
      {...base, input: 1000, cached: 950},
      {...base, input: 1000, cached: 0, cold: 'idle 73 min (past the cache lifetime)'},
      {...base, input: 1000, cached: 0, cold: 'idle 64 min (past the cache lifetime)'},
      {...base, input: 1000, cached: 100},
    ], 7, 'all projects');
    expect(text).toMatch(/\n  idle \(past the cache lifetime\) +2 turns +2K\n/);
    expect(text).toMatch(/\n  unexplained \(the system prompt or tools changed, or the provider evicted it\) +1 turns +900$/);
    expect(formatCache([], 7, 'x')).toMatch(/^No prompt-cache data/);
  });
});
