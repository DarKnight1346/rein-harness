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
const collect = async (it: AsyncIterable<EngineEvent>) => {
  const out: EngineEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};
const engine = () => {
  const router = makeRouter(() => config, makeAutoRouter({config: () => config}));
  return new Engine({config: () => config, route: router.route, alternative: router.alternative, compact: (t, _r, opts) => compactTranscript(t, config, opts)});
};
// Fake sonnet has a 200k window; auto-compact at 80% → 160k. Token counts are cumulative over a
// turn's requests: the first request is 5k, the next one 175k (over the threshold).
const firstRequest: ChatEvent = {type: 'tokens', call: {input: 5_000, cached: 0, output: 0}};
const bigRequest: ChatEvent = {type: 'tokens', call: {input: 180_000, cached: 0, output: 0}};

beforeEach(() => {
  config = {...DEFAULT_CONFIG, chatModel: 'claude:sonnet', autoCompactPct: 80};
  usageStore.reset();
  catalog.authFailed.clear();
});

describe('mid-turn compaction', () => {
  it('compacts when a request crosses the threshold and the agent carries on in the same turn', async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, (p) =>
      p.includes('<context_compacted>') ? reply('all done') : [firstRequest, {type: 'text', delta: 'step one done. '}, bigRequest, {type: 'done', interrupted: true}],
    );
    install('claude', adapter);
    await catalog.refresh();
    const e = engine();
    const evs = await collect(e.send('refactor everything'));

    const compacts = evs.filter((x) => x.type === 'compact');
    expect(compacts.map((x: any) => [x.phase, x.reason])).toEqual([['start', 'midturn'], ['end', 'midturn']]);
    expect(evs.filter((x) => x.type === 'done')).toEqual([{type: 'done', interrupted: false}]); // one turn, never stopped
    expect(evs.at(-1)).toEqual({type: 'done', interrupted: false});

    const msgs = e.transcript.messages;
    expect(msgs.map((m) => [m.role, !!m.synthetic])).toEqual([['user', false], ['assistant', false], ['user', true], ['assistant', false]]);
    expect(msgs[1]!.text).toBe('step one done. '); // the interrupted work is kept, not discarded
    expect(msgs[1]!.interrupted).toBeUndefined();
    expect(msgs[3]!.text).toBe('all done');
    expect(e.transcript.summary?.coversUpTo).toBe(2); // the task and the work so far are in the summary

    expect(log.opened).toHaveLength(2); // a fresh native session after compaction
    const continuation = log.prompts[1]!.prompt;
    expect(continuation).toContain('<context_compacted>');
    expect(continuation).not.toMatch(/refactor everything$/); // not a re-send of the original request
  });

  it('keeps the work and continues when the context overflows mid-task', async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, (p) =>
      p.includes('<context_compacted>') ? reply('finished') : [{type: 'text', delta: 'edited three files. '}, {type: 'error', kind: 'context', message: 'prompt is too long'}],
    );
    install('claude', adapter);
    await catalog.refresh();
    const e = engine();
    const evs = await collect(e.send('migrate the API'));

    expect(evs.some((x) => x.type === 'compact' && x.phase === 'end' && x.reason === 'context')).toBe(true);
    expect(evs.some((x) => x.type === 'error')).toBe(false);
    expect(evs.at(-1)).toEqual({type: 'done', interrupted: false});
    expect(e.transcript.messages.map((m) => m.text)).toEqual(['migrate the API', 'edited three files. ', expect.stringContaining('<context_compacted>'), 'finished']);
    expect(log.prompts).toHaveLength(2);
  });

  it('a user interrupt is not mistaken for a compaction stop', async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => [firstRequest, bigRequest, {type: 'text', delta: 'partial'}, {type: 'done', interrupted: true}]);
    install('claude', adapter);
    await catalog.refresh();
    const e = engine();
    const run = e.send('long task');
    const first = await run.next(); // routing done, the turn is underway
    e.interrupt();
    const evs = [first.value as EngineEvent, ...(await collect(run))];
    expect(evs.some((x) => x.type === 'compact' && x.reason === 'midturn')).toBe(false);
    expect(e.transcript.messages.some((m) => m.synthetic)).toBe(false);
  });

  it("doesn't compact on a segment's first request (nothing to fold away yet)", async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => [{type: 'tokens', call: {input: 180_000, cached: 0, output: 0}}, ...reply('done')]);
    install('claude', adapter);
    await catalog.refresh();
    const evs = await collect(engine().send('task'));
    expect(evs.some((x) => x.type === 'compact' && x.reason === 'midturn')).toBe(false);
  });

  it('does nothing mid-turn when auto-compact is off', async () => {
    config.autoCompactPct = 0;
    await tempHome([acct('claude', 'c1')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => [firstRequest, bigRequest, ...reply('done')]);
    install('claude', adapter);
    await catalog.refresh();
    const evs = await collect(engine().send('task'));
    expect(evs.some((x) => x.type === 'compact')).toBe(false);
    expect(log.prompts).toHaveLength(1);
  });
});
