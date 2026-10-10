import {beforeEach, describe, expect, it} from 'vitest';
import {catalog} from '../src/router/catalog.js';
import {makeRouter} from '../src/router/index.js';
import {makeAutoRouter} from '../src/router/auto.js';
import {Engine, type EngineEvent} from '../src/session/engine.js';
import {compactTranscript} from '../src/session/compactor.js';
import {DEFAULT_CONFIG, type Config} from '../src/store/config.js';
import {usageStore} from '../src/store/usage.js';
import type {ChatEvent} from '../src/providers/types.js';
import {acct, CLAUDE_FAKE_MODELS, fakeAdapter, install, reply, tempHome} from './fakes.js';

let config: Config;
const drain = async (it: AsyncIterable<EngineEvent>) => {
  for await (const _ of it);
};
const engine = () => {
  const router = makeRouter(() => config, makeAutoRouter({config: () => config}));
  return new Engine({config: () => config, route: router.route, alternative: router.alternative, compact: (t, _r, opts) => compactTranscript(t, config, opts)});
};
/** Two turns whose requests are `input` tokens: enough history to compact (the last two messages stay). */
async function idleAfterTwoTurns(input: number) {
  await tempHome([acct('claude', 'c1')]);
  const big: ChatEvent = {type: 'tokens', call: {input, cached: 0, output: 0}};
  const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, (p) => (p.includes('compaction_request') || p.includes('ummar') ? reply('The summary.') : [big, ...reply('done')]));
  install('claude', adapter);
  await catalog.refresh();
  const e = engine();
  await drain(e.send('step one'));
  await drain(e.send('step two'));
  return {e, log};
}

beforeEach(() => {
  // Fake sonnet: a 200k window, auto-compact at 80% (160k); idle compaction from 40% of that (64k).
  config = {...DEFAULT_CONFIG, chatModel: 'claude:sonnet', autoCompactPct: 80, experiments: ['idle-compact']};
  usageStore.reset();
  catalog.authFailed.clear();
});

describe('idle-compact', () => {
  it('compacts an idle conversation a little before its prompt cache expires', async () => {
    const {e} = await idleAfterTwoTurns(100_000);
    const at = e.idleCompactAt()!;
    expect(at - e.lastUsage!.at).toBe(58 * 60_000); // the 1-hour cache, 2 minutes early
    const res = await e.idleCompact();
    expect(res && 'skipped' in res).toBe(false);
    expect(e.transcript.summary).toBeDefined();
    expect(e.idleCompactAt()).toBeUndefined(); // done: no second compaction for the same idle stretch
  });

  it('uses the 5-minute lifetime with cache-5m', async () => {
    config.experiments = ['idle-compact', 'cache-5m'];
    const {e} = await idleAfterTwoTurns(100_000);
    expect(e.idleCompactAt()! - e.lastUsage!.at).toBe(4 * 60_000);
  });

  it('leaves a small conversation alone, and is off without the experiment', async () => {
    expect((await idleAfterTwoTurns(20_000)).e.idleCompactAt()).toBeUndefined();
    config.experiments = [];
    expect((await idleAfterTwoTurns(100_000)).e.idleCompactAt()).toBeUndefined();
  });

  it("doesn't compact once the cache has already expired (nothing left to save)", async () => {
    const {e} = await idleAfterTwoTurns(100_000);
    e.lastUsage!.at -= 61 * 60_000;
    expect(await e.idleCompact()).toBeUndefined();
    expect(e.transcript.summary).toBeUndefined();
  });
});
