import {beforeEach, describe, expect, it} from 'vitest';
import {catalog} from '../src/router/catalog.js';
import {makeRouter} from '../src/router/index.js';
import {makeAutoRouter} from '../src/router/auto.js';
import {Engine, type EngineEvent} from '../src/session/engine.js';
import {compactTranscript} from '../src/session/compactor.js';
import {DEFAULT_CONFIG, type Config} from '../src/store/config.js';
import {usageStore} from '../src/store/usage.js';
import {acct, CLAUDE_FAKE_MODELS, fakeAdapter, install, tempHome} from './fakes.js';

let config: Config;
let input = 0;
beforeEach(async () => {
  config = {...DEFAULT_CONFIG, chatModel: 'claude:sonnet', experiments: [], autoCompactPct: 0};
  usageStore.reset();
  await tempHome([acct('claude', 'c1')]);
  const {adapter} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => [{type: 'text', delta: 'ok'}, {type: 'done', interrupted: false, tokens: {input, output: 10}}]);
  install('claude', adapter);
  await catalog.refresh();
});
const notices = async (e: Engine, tokens: number) => {
  input = tokens;
  const out: EngineEvent[] = [];
  for await (const ev of e.send('next')) out.push(ev);
  return out.filter((x): x is Extract<EngineEvent, {type: 'notice'}> => x.type === 'notice').map((x) => x.text);
};
const engine = () => {
  const router = makeRouter(() => config, makeAutoRouter({config: () => config}));
  const e = new Engine({config: () => config, route: router.route, alternative: router.alternative, compact: (t) => compactTranscript(t, config)});
  // Earlier work: one huge read (its full size, stored clipped) and a small listing.
  e.transcript.messages.push({role: 'assistant', text: 'read it', at: 0, tools: [
    {label: 'Read', summary: 'src/huge.ts', ok: true, result: 'x'.repeat(4000), size: 160_000},
    {label: 'List', summary: '.', ok: true, result: 'a b', size: 3},
  ]});
  return e;
};

describe('context-bloat warnings', () => {
  it('say once per level how full the context is and what is biggest', async () => {
    const e = engine();
    expect(await notices(e, 60_000)).toEqual([]); // 30% of the fake 200K window
    const [first] = await notices(e, 120_000);
    expect(first).toMatch(/^Context is 60% full \(120K of 200K tokens\)\. Largest: Read\(src\/huge\.ts\) 40K\. \/compact/);
    expect(await notices(e, 130_000)).toEqual([]); // still the 50% level
    expect((await notices(e, 150_000))[0]).toMatch(/75% full/);
  });

  it('stay quiet when compaction is about to run anyway, or when turned off', async () => {
    config.autoCompactPct = 80;
    expect(await notices(engine(), 170_000)).toEqual([]);
    config.autoCompactPct = 0;
    config.contextWarnings = false;
    expect(await notices(engine(), 120_000)).toEqual([]);
  });
});
