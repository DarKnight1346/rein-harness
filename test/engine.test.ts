import {beforeEach, describe, expect, it} from 'vitest';
import {catalog} from '../src/router/catalog.js';
import {makeRouter} from '../src/router/index.js';
import {makeAutoRouter} from '../src/router/auto.js';
import {Engine, limitWait, type EngineEvent} from '../src/session/engine.js';
import {compactTranscript} from '../src/session/compactor.js';
import {DEFAULT_CONFIG, type Config} from '../src/store/config.js';
import {usageStore} from '../src/store/usage.js';
import {acct, CLAUDE_FAKE_MODELS, CODEX_FAKE_MODELS, fakeAdapter, install, reply, tempHome} from './fakes.js';

let config: Config;
const collect = async (it: AsyncIterable<EngineEvent>) => {
  const out: EngineEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};
function engineWith(auto = false) {
  const autoRouter = makeAutoRouter({config: () => config});
  const router = makeRouter(() => config, autoRouter);
  return new Engine({config: () => config, route: router.route, alternative: router.alternative, compact: (t) => compactTranscript(t, config)});
}

beforeEach(() => {
  config = {...DEFAULT_CONFIG, chatModel: 'claude:sonnet'};
  usageStore.reset();
  catalog.authFailed.clear();
});

describe('waiting for a limit to reset', () => {
  beforeEach(() => Object.assign(limitWait, {pollMs: 50, marginMs: 0}));
  const limitedOnly = async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('back again'));
    install('claude', adapter);
    await catalog.refresh();
    return log;
  };

  it('waits for the earliest reset, then carries on with the turn', async () => {
    const log = await limitedOnly();
    usageStore.coolDown('c1', Date.now() + 400);
    const t = Date.now();
    const evs = await collect(engineWith().send('keep going'));
    expect(Date.now() - t).toBeGreaterThanOrEqual(350);
    expect(evs.find((x) => x.type === 'waiting')).toMatchObject({type: 'waiting'});
    expect(evs.some((x) => x.type === 'notice' && /Limit reset/.test(x.text))).toBe(true);
    expect(log.prompts.at(-1)!.prompt).toContain('keep going');
    expect(evs.at(-1)).toEqual({type: 'done', interrupted: false});
  });

  it('stops waiting on Esc, and does not wait when it is off or the reset is too far', async () => {
    await limitedOnly();
    usageStore.coolDown('c1', Date.now() + 3600_000);
    const e = engineWith();
    setTimeout(() => e.interrupt(), 150);
    const evs = await collect(e.send('wait'));
    expect(evs.at(-1)).toEqual({type: 'done', interrupted: true});
    config.waitForLimits = false;
    expect((await collect(engineWith().send('no wait'))).at(-1)).toMatchObject({type: 'error', message: expect.stringMatching(/at its limit/)});
    config.waitForLimits = true;
    usageStore.coolDown('c1', Date.now() + 3 * 24 * 3600_000); // a weekly limit
    expect((await collect(engineWith().send('too far'))).some((x) => x.type === 'waiting')).toBe(false);
  });
});

describe('engine', () => {
  it('reuses one native session across turns and switches model in place', async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, (p) => reply(`echo:${p.slice(-5)}`));
    install('claude', adapter);
    await catalog.refresh();
    const e = engineWith();
    await collect(e.send('hello'));
    config.chatModel = 'claude:haiku';
    const evs = await collect(e.send('again'));
    expect(log.opened).toHaveLength(1);
    expect(log.setModel).toEqual(['haiku']);
    expect(log.prompts.map((p) => p.prompt)).toEqual(['hello', 'again']); // no carry needed
    expect(evs.at(-1)).toEqual({type: 'done', interrupted: false});
    expect(e.transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('fails over to the next account on a limit error, carrying context', async () => {
    await tempHome([acct('claude', 'c1'), acct('claude', 'c2')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, (p, ctx) =>
      ctx.accountId === 'c1' && p.includes('second') ? [{type: 'error', kind: 'limit', message: 'limit', resetsAt: Date.now() + 3600_000}] : reply('ok'),
    );
    install('claude', adapter);
    await catalog.refresh();
    usageStore.set('c1', {windows: [{usedPct: 10, windowMins: 300}], at: Date.now(), source: 'live'});
    usageStore.set('c2', {windows: [{usedPct: 50, windowMins: 300}], at: Date.now(), source: 'live'});
    const e = engineWith();
    await collect(e.send('first'));
    usageStore.coolDown('c1', 0); // no-op; c1 healthy until it errors
    const evs = await collect(e.send('second'));
    expect(evs.some((x) => x.type === 'notice' && /hit its limit/.test(x.text))).toBe(true);
    const last = log.prompts.at(-1)!;
    expect(last.accountId).toBe('c2');
    expect(last.prompt).toContain('User: first'); // carry
    expect(last.prompt.endsWith('second')).toBe(true);
    expect(usageStore.cooldownUntil('c1')).toBeGreaterThan(Date.now());
    expect(evs.at(-1)).toEqual({type: 'done', interrupted: false});
  });

  it('switches provider when every account for the model is limited', async () => {
    await tempHome([acct('claude', 'c1'), acct('codex', 'x1')]);
    const claude = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => [{type: 'error', kind: 'limit', message: 'limit'}]);
    const codex = fakeAdapter('codex', CODEX_FAKE_MODELS, () => reply('from codex'));
    install('claude', claude.adapter);
    install('codex', codex.adapter);
    await catalog.refresh();
    const e = engineWith();
    const evs = await collect(e.send('hi'));
    expect(evs.filter((x) => x.type === 'notice').map((x: any) => x.text).join('\n')).toMatch(/switching to GPT-X/);
    expect(codex.log.prompts).toHaveLength(1);
    expect(e.transcript.messages.at(-1)).toMatchObject({role: 'assistant', text: 'from codex', model: {provider: 'codex', model: 'gpt-x'}});
  });

  it('reports an error when nothing is available', async () => {
    await tempHome([acct('claude', 'c1')]);
    install('claude', fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => [{type: 'error', kind: 'limit', message: 'limit'}]).adapter);
    await catalog.refresh();
    config.waitForLimits = false; // (by default it would wait for the reset: see above)
    const evs = await collect(engineWith().send('hi'));
    expect(evs.at(-1)).toMatchObject({type: 'error'});
  });
});

describe('auto routing (LLM decider)', () => {
  it('routes, stays sticky, and falls back to default on low confidence', async () => {
    await tempHome([acct('claude', 'c1')]);
    let answer = '{"model": {"choice": "claude:haiku", "confidence": 0.9}}';
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('ok'), () => answer);
    install('claude', adapter);
    await catalog.refresh();
    config = {...config, chatModel: 'auto'};
    const e = engineWith();
    const first = await collect(e.send('what is 2+2'));
    expect(first.find((x) => x.type === 'route')).toMatchObject({route: {ref: {model: 'haiku'}, reason: 'auto', confidence: 0.9}});
    // decider used the cheapest model, fast mode, and never saw the transcript
    expect(log.oneShots[0]).toMatchObject({model: 'haiku', fast: true});
    expect(log.oneShots[0]!.prompt).toContain('what is 2+2');

    answer = '{"switch": 0.2, "model": {"choice": "claude:sonnet", "confidence": 0.9}}';
    const second = await collect(e.send('and 3+3?'));
    expect(second.find((x) => x.type === 'route')).toMatchObject({route: {ref: {model: 'haiku'}, reason: 'sticky'}});
    // Minimal state: new message + one-line task tag, never the transcript or replies.
    expect(log.oneShots[1]!.prompt).toContain('"current_task":"what is 2+2"');
    expect(log.oneShots[1]!.prompt).not.toMatch(/User:|Assistant:/);

    answer = '{"switch": 0.95, "model": {"choice": "claude:haiku", "confidence": 0.1}}';
    const third = await collect(e.send('now something totally different'));
    expect(third.find((x) => x.type === 'route')).toMatchObject({route: {ref: {model: 'sonnet'}, reason: 'default'}});
  });

  it('makes no decider call with a single candidate', async () => {
    await tempHome([acct('codex', 'x1')]);
    const {adapter, log} = fakeAdapter('codex', CODEX_FAKE_MODELS, () => reply('ok'));
    install('codex', adapter);
    await catalog.refresh();
    config = {...config, chatModel: 'auto'};
    await collect(engineWith().send('hi'));
    expect(log.oneShots).toHaveLength(0);
  });
});

describe('auto-compaction events', () => {
  it('compacts past the threshold and reports before/after', async () => {
    await tempHome([acct('claude', 'c1')]);
    const tiny = [{...CLAUDE_FAKE_MODELS[0]!, contextWindow: 400}, CLAUDE_FAKE_MODELS[1]!];
    const {adapter} = fakeAdapter('claude', tiny, () => reply('a fairly long reply '.repeat(20)), () => 'GOAL: short');
    install('claude', adapter);
    await catalog.refresh();
    config = {...config, chatModel: 'claude:haiku', autoCompactPct: 50};
    const e = engineWith();
    for (const m of ['one', 'two']) await collect(e.send(m));
    const evs = await collect(e.send('three'));
    const start = evs.find((x) => x.type === 'compact' && x.phase === 'start');
    const end = evs.find((x) => x.type === 'compact' && x.phase === 'end') as any;
    expect(start).toMatchObject({reason: 'auto', messages: 2});
    expect(end.result.summarized).toBe(2);
    expect(end.result.afterTokens).toBeLessThan(end.result.beforeTokens);
    // off → no compaction
    config = {...config, autoCompactPct: 0};
    const quiet = await collect(e.send('four'));
    expect(quiet.some((x) => x.type === 'compact')).toBe(false);
  });
});

describe('price-break', () => {
  it('keeps a model with a pricier rate card above some prompt size below it, when on', async () => {
    await tempHome([acct('claude', 'c1')]);
    const priced = [{...CLAUDE_FAKE_MODELS[0]!, contextWindow: 1_000_000, priceBreak: 100_000}, CLAUDE_FAKE_MODELS[1]!];
    const {adapter} = fakeAdapter('claude', priced, () => reply('ok'));
    install('claude', adapter);
    await catalog.refresh();
    const ref = {provider: 'claude' as const, model: priced[0]!.id};
    const e = engineWith() as any;
    expect(e.autoCompactLimit(ref)).toBe(800_000); // off: 80% of the window
    config = {...config, experiments: ['price-break']};
    expect(e.autoCompactLimit(ref)).toBe(80_000); // under the 100K break, with headroom
    expect(e.autoCompactLimit({provider: 'claude', model: CLAUDE_FAKE_MODELS[1]!.id})).toBe(CLAUDE_FAKE_MODELS[1]!.contextWindow * 0.8); // flat-priced
  });
});

describe('context-cap', () => {
  it('compacts large windows at 200K when on', async () => {
    await tempHome([acct('claude', 'c1')]);
    const big = [{...CLAUDE_FAKE_MODELS[0]!, contextWindow: 1_000_000}, CLAUDE_FAKE_MODELS[1]!];
    const {adapter} = fakeAdapter('claude', big, () => reply('ok'));
    install('claude', adapter);
    await catalog.refresh();
    const e = engineWith() as any;
    expect(e.autoCompactLimit({provider: 'claude', model: big[0]!.id})).toBe(800_000);
    config = {...config, experiments: ['context-cap']};
    expect(e.autoCompactLimit({provider: 'claude', model: big[0]!.id})).toBe(200_000);
    expect(e.autoCompactLimit({provider: 'claude', model: big[1]!.id})).toBe(Math.min(200_000, big[1]!.contextWindow * 0.8));
  });
});

describe('faithful-compaction', () => {
  it("keeps the user's requests word for word, shows the summarizer real tool output, and uses the working model", async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('ok'), () => 'GOAL: test');
    install('claude', adapter);
    await catalog.refresh();
    const e = engineWith();
    const spec = 'Implement classes. Exact error: `SyntaxError: Unexpected token` at 3:7, and keep ASI working.';
    await collect(e.send(spec));
    e.transcript.messages.push({role: 'assistant', text: 'working', at: 0, tools: [{label: 'Shell', summary: '$ go test', ok: false, result: 'x'.repeat(1000) + 'FAIL TestClassFields: want 3 got 4'}]});
    for (const m of ['two', 'three']) await collect(e.send(m));
    const working = {provider: 'claude' as const, model: CLAUDE_FAKE_MODELS[1]!.id};
    await compactTranscript(e.transcript, {...config, experiments: ['faithful-compaction']}, {keepRecent: 0, model: working});
    expect(log.oneShots[0]!.model).toBe(working.model);
    expect(log.oneShots[0]!.prompt).toContain('FAIL TestClassFields: want 3 got 4'); // past the old 300-char excerpt
    expect(log.oneShots[0]!.system).toContain('FAILED APPROACHES');
    expect(e.transcript.summary!.map).toContain(`--- request 1 ---\n${spec}`);
  });
});

describe('compactor', () => {
  it('summarizes old messages, keeps recent ones, and drops native refs', async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter, log} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => reply('ok'), () => 'GOAL: test');
    install('claude', adapter);
    await catalog.refresh();
    const e = engineWith();
    for (const m of ['one', 'two', 'three']) await collect(e.send(m));
    expect(Object.keys(e.transcript.native)).toHaveLength(1);
    const res = await e.compactNow();
    expect(res).toMatchObject({summarized: 4});
    expect(e.transcript.summary).toMatchObject({text: 'GOAL: test', coversUpTo: 4});
    expect(e.transcript.native).toEqual({});
    expect(log.oneShots[0]!.prompt).toContain('User: one');
    await collect(e.send('four'));
    const last = log.prompts.at(-1)!.prompt;
    expect(last).toContain('GOAL: test');
    expect(last).toContain('User: three');
    expect(last).not.toContain('User: one');
    expect(log.opened).toHaveLength(2);
  });
});
