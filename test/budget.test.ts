import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {effectiveBudget, overBudget} from '../src/budget.js';
import {catalog} from '../src/router/catalog.js';
import {makeRouter} from '../src/router/index.js';
import {makeAutoRouter} from '../src/router/auto.js';
import {Engine, type EngineEvent} from '../src/session/engine.js';
import {compactTranscript} from '../src/session/compactor.js';
import {DEFAULT_CONFIG, type Config} from '../src/store/config.js';
import {usageStore} from '../src/store/usage.js';
import {acct, CLAUDE_FAKE_MODELS, fakeAdapter, install, tempHome} from './fakes.js';

describe('budgets', () => {
  it("take the lower of the user's cap and the repo's", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rein-budget-'));
    mkdirSync(path.join(root, '.rein'));
    writeFileSync(path.join(root, '.rein', 'settings.json'), JSON.stringify({budget: {requestUsd: 1, goalUsd: 100}}));
    expect(effectiveBudget({requestUsd: 5, goalUsd: 20}, root)).toEqual({requestUsd: 1, goalUsd: 20});
    expect(effectiveBudget(undefined, root)).toEqual({requestUsd: 1, goalUsd: 100});
    expect(effectiveBudget({conversationUsd: -3}, os.tmpdir())).toEqual({}); // nonsense is ignored
  });

  it('say which cap was reached, the widest first', () => {
    expect(overBudget({request: 1.99, conversation: 10}, {requestUsd: 2})).toBeUndefined();
    expect(overBudget({request: 2.01, conversation: 10}, {requestUsd: 2})).toMatch(/this request has cost \$2\.01 of its \$2\.00 budget/);
    expect(overBudget({request: 3, goal: 21, conversation: 60}, {requestUsd: 2, goalUsd: 20, conversationUsd: 50})).toMatch(/this conversation/);
    expect(overBudget({request: 0, conversation: 1}, {goalUsd: 1})).toBeUndefined(); // no goal running
  });
});

describe('a budget stop in the engine', () => {
  let config: Config;
  beforeEach(() => {
    config = {...DEFAULT_CONFIG, chatModel: 'claude:sonnet', experiments: []};
    usageStore.reset();
  });
  const collect = async (it: AsyncIterable<EngineEvent>) => {
    const out: EngineEvent[] = [];
    for await (const ev of it) out.push(ev);
    return out;
  };

  it('interrupts the turn once the spend reaches a cap, and refuses the next message', async () => {
    await tempHome([acct('claude', 'c1')]);
    const {adapter} = fakeAdapter('claude', CLAUDE_FAKE_MODELS, () => [
      {type: 'tokens', call: {input: 1000, cached: 0, output: 100, usd: 3}},
      {type: 'text', delta: 'still going'},
      {type: 'done', interrupted: true},
    ]);
    install('claude', adapter);
    await catalog.refresh();
    const router = makeRouter(() => config, makeAutoRouter({config: () => config}));
    let spent = 0;
    const engine: Engine = new Engine({
      config: () => config,
      route: router.route,
      alternative: router.alternative,
      compact: (t) => compactTranscript(t, config),
      overBudget: () => ((spent = engine.sessionTokens.usd ?? 0) >= 2 ? `Budget reached: $${spent} of $2.` : undefined),
    });
    const first = await collect(engine.send('build it'));
    expect(first.find((e) => e.type === 'notice')).toEqual({type: 'notice', text: 'Budget reached: $3 of $2.'});
    expect(first.at(-1)).toEqual({type: 'done', interrupted: true});
    const second = await collect(engine.send('and more'));
    expect(second).toEqual([{type: 'error', message: expect.stringMatching(/^Budget reached.*start a new conversation/)}]);
    expect(engine.transcript.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['build it']);
  });
});
