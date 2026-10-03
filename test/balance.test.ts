import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {catalog} from '../src/router/catalog.js';
import {makeRouter} from '../src/router/index.js';
import {makeAutoRouter} from '../src/router/auto.js';
import {Engine, type EngineEvent} from '../src/session/engine.js';
import {compactTranscript} from '../src/session/compactor.js';
import {DEFAULT_CONFIG, type Config} from '../src/store/config.js';
import {balanceScore, usageStore} from '../src/store/usage.js';
import {acct, CLAUDE_FAKE_MODELS, fakeAdapter, install, reply, tempHome} from './fakes.js';

let config: Config;
const collect = async (it: AsyncIterable<EngineEvent>) => {
  const out: EngineEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};
const engine = () => {
  const router = makeRouter(() => config, makeAutoRouter({config: () => config}));
  return new Engine({config: () => config, route: router.route, alternative: router.alternative, compact: (t) => compactTranscript(t, config)});
};
const usage = (id: string, usedPct: number, resetsInMin = 240, windowMins = 300) =>
  usageStore.set(id, {windows: [{usedPct, windowMins, resetsAt: Date.now() + resetsInMin * 60_000}], at: Date.now(), source: 'live'});

let log: ReturnType<typeof fakeAdapter>['log'];
beforeEach(async () => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
  config = {...DEFAULT_CONFIG, chatModel: 'claude:sonnet'};
  usageStore.reset();
  catalog.authFailed.clear();
  catalog.busy.clear();
  await tempHome([acct('claude', 'c1'), acct('claude', 'c2')]);
  const fake = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('ok'));
  log = fake.log;
  install('claude', fake.adapter);
  await catalog.refresh();
});
afterEach(() => vi.useRealTimers());
const lastAccount = () => log.prompts.at(-1)!.accountId;
const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000);

describe('balance score', () => {
  it('discounts usage by time left before the window resets', () => {
    const now = Date.now();
    const snap = (usedPct: number, leftMin: number, windowMins = 300) => ({windows: [{usedPct, windowMins, resetsAt: now + leftMin * 60_000}], at: now, source: 'live' as const});
    expect(balanceScore(snap(80, 10), now)).toBeGreaterThan(95); // resets soon: nearly free
    expect(balanceScore(snap(60, 6 * 1440, 10080), now)).toBeCloseTo(48.6, 0); // a week's pressure
    expect(balanceScore(snap(95, 5), now)).toBe(5); // near the limit: real headroom counts
    expect(balanceScore(undefined, now)).toBe(70); // unknown: worth trying
  });
});

describe('load balancing', () => {
  it('starts a conversation on the account with the most room', async () => {
    usage('c1', 60);
    usage('c2', 10);
    await collect(engine().send('hi'));
    expect(lastAccount()).toBe('c2');
  });

  it('stays while the prompt cache is warm, even if another account is better', async () => {
    usage('c1', 10);
    usage('c2', 30);
    const e = engine();
    await collect(e.send('one'));
    expect(lastAccount()).toBe('c1');
    usage('c1', 70); // c1 got busy elsewhere
    minutes(2);
    await collect(e.send('two'));
    expect(lastAccount()).toBe('c1');
  });

  it('moves once the cache is cold and another account is clearly better', async () => {
    usage('c1', 10);
    usage('c2', 30);
    const e = engine();
    await collect(e.send('one'));
    usage('c1', 70);
    minutes(30);
    await collect(e.send('still warm')); // Claude keeps the cache for an hour
    expect(lastAccount()).toBe('c1');
    minutes(61);
    usage('c1', 70);
    const evs = await collect(e.send('two'));
    expect(lastAccount()).toBe('c2');
    expect(evs.some((x) => x.type === 'notice' && /cache was cold/.test(x.text))).toBe(true);
    expect(log.prompts.at(-1)!.prompt).toContain('User: one'); // context carried over
  });

  it('may move right after compaction (the cache is gone), even within minutes', async () => {
    usage('c1', 10);
    usage('c2', 30);
    const e = engine();
    for (const m of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) await collect(e.send(m));
    usage('c1', 70);
    minutes(1); // warm, but…
    const res = await e.compactNow();
    expect(res).toMatchObject({summarized: expect.any(Number)});
    const evs = await collect(e.send('eight'));
    expect(lastAccount()).toBe('c2');
    expect(evs.some((x) => x.type === 'notice' && /after compaction/.test(x.text))).toBe(true);
  });

  it("doesn't flip-flop over a small difference", async () => {
    usage('c1', 10);
    usage('c2', 15);
    const e = engine();
    await collect(e.send('one'));
    usage('c1', 25);
    minutes(61);
    await collect(e.send('two'));
    expect(lastAccount()).toBe('c1');
  });

  it('leaves an account near its limit right away, before a rejection', async () => {
    usage('c1', 10);
    usage('c2', 40);
    const e = engine();
    await collect(e.send('one'));
    usage('c1', 93);
    minutes(1); // cache still warm
    const evs = await collect(e.send('two'));
    expect(lastAccount()).toBe('c2');
    expect(evs.some((x) => x.type === 'notice' && /near its limit/.test(x.text))).toBe(true);
  });

  it('sticky mode keeps the old behavior', async () => {
    config.loadBalancing = 'sticky';
    usage('c1', 10);
    usage('c2', 30);
    const e = engine();
    await collect(e.send('one'));
    usage('c1', 80);
    minutes(30);
    await collect(e.send('two'));
    expect(lastAccount()).toBe('c1');
  });

  it('spreads parallel sessions: a live session counts against its account', () => {
    usage('c1', 10);
    usage('c2', 20);
    const ref = {provider: 'claude' as const, model: 'sonnet'};
    expect(catalog.healthyAccounts(ref, 98)[0]!.id).toBe('c1');
    const s = catalog.track({accountId: 'c1', close() {}});
    expect(catalog.healthyAccounts(ref, 98)[0]!.id).toBe('c2');
    s.close();
    expect(catalog.healthyAccounts(ref, 98)[0]!.id).toBe('c1');
  });
});

describe('subagent accounts', () => {
  it('a fork uses the forking agent\'s account; other subagents take the best account', async () => {
    usage('c1', 10);
    usage('c2', 40);
    const e = engine();
    await collect(e.send('one')); // main conversation on c1
    expect(e.current?.accountId).toBe('c1');
    usage('c1', 60); // c2 is now the better account…
    const ref = {provider: 'claude' as const, model: 'sonnet'};
    // …so a new subagent goes there, while a fork stays with its parent on c1 (runtime.openSubagent).
    expect(catalog.healthyAccounts(ref, 98)[0]!.id).toBe('c2');
    expect(e.current?.accountId).toBe('c1');
  });
});

describe('either window running out makes the account unusable', () => {
  const ref = {provider: 'claude' as const, model: 'sonnet'};
  const both = (id: string, fiveH: number, weekly: number) =>
    usageStore.set(id, {
      windows: [
        {usedPct: fiveH, windowMins: 300, resetsAt: Date.now() + 120 * 60_000},
        {usedPct: weekly, windowMins: 10080, resetsAt: Date.now() + 3 * 1440 * 60_000},
      ],
      at: Date.now(),
      source: 'live',
    });
  it('weekly exhausted, 5h fresh → skipped', () => {
    both('c1', 2, 100);
    both('c2', 50, 50);
    expect(catalog.healthyAccounts(ref, 98).map((a) => a.id)).toEqual(['c2']);
  });
  it('5h exhausted, weekly fresh → skipped', () => {
    both('c1', 100, 5);
    both('c2', 50, 50);
    expect(catalog.healthyAccounts(ref, 98).map((a) => a.id)).toEqual(['c2']);
  });
  it('the tighter window decides the score', () => {
    both('c1', 5, 85); // weekly nearly gone
    both('c2', 40, 20);
    expect(catalog.healthyAccounts(ref, 98)[0]!.id).toBe('c2');
  });
});

describe('removing the account a conversation is on', () => {
  it('continues on another account with the context carried over', async () => {
    usage('c1', 10);
    usage('c2', 40);
    const e = engine();
    await collect(e.send('remember PELICAN'));
    expect(lastAccount()).toBe('c1');
    catalog.retired.add('c1');
    e.releaseAccount('c1');
    const evs = await collect(e.send('what did I say?'));
    expect(lastAccount()).toBe('c2');
    expect(log.prompts.at(-1)!.prompt).toContain('remember PELICAN');
    expect(evs.some((x) => x.type === 'notice' && /previous account was removed/.test(x.text))).toBe(true);
    expect(evs.at(-1)).toEqual({type: 'done', interrupted: false});
    catalog.retired.delete('c1');
  });
});
