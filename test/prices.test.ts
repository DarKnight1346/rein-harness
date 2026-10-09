import {afterEach, describe, expect, it} from 'vitest';
import {addTokens, formatUsd, priceFor, requestCost, setCacheWriteTtl, setPriceOverrides} from '../src/providers/prices.js';

afterEach(() => {
  setCacheWriteTtl(() => '1h');
  setPriceOverrides(() => undefined);
});

const opus = {provider: 'claude' as const, model: 'opus'};

describe('prices', () => {
  it('prices a Claude request from its plain input, cache hits, cache writes and output', () => {
    // Opus 5.5: $4 in, $0.20 cache hit, $8 1h write, $20 out per MTok.
    expect(requestCost(opus, {input: 1_000_000, cached: 0, output: 0})).toBeCloseTo(4);
    expect(requestCost(opus, {input: 1_000_000, cached: 1_000_000, output: 0})).toBeCloseTo(0.2);
    expect(requestCost(opus, {input: 1_000_000, cached: 0, written: 1_000_000, output: 0})).toBeCloseTo(8);
    expect(requestCost(opus, {input: 0, cached: 0, output: 1_000_000})).toBeCloseTo(20);
    setCacheWriteTtl(() => '5m');
    expect(requestCost(opus, {input: 1_000_000, cached: 0, written: 1_000_000, output: 0})).toBeCloseTo(5);
  });

  it("charges Haiku 5.5's higher price for the whole request once its prompt is over 100K tokens", () => {
    const haiku = {provider: 'claude' as const, model: 'haiku'};
    expect(requestCost(haiku, {input: 100_000, cached: 0, output: 0})).toBeCloseTo(0.01);
    expect(requestCost(haiku, {input: 200_000, cached: 100_000, output: 0})).toBeCloseTo(0.1 * 0.5 + 0.1 * 0.05);
  });

  it('knows full model ids and Codex models, and long-context OpenAI pricing', () => {
    expect(priceFor({provider: 'claude', model: 'claude-sonnet-4-6'})?.input).toBe(3);
    expect(priceFor({provider: 'claude', model: 'claude-opus-5'})?.output).toBe(25);
    expect(priceFor({provider: 'claude', model: 'fable'})?.cached).toBe(0.25);
    const sol = {provider: 'codex' as const, model: 'gpt-6.1-sol'};
    expect(requestCost(sol, {input: 1_000_000, cached: 0, output: 0})).toBeCloseTo(4); // over 272K: $4
    expect(requestCost(sol, {input: 100_000, cached: 0, output: 0})).toBeCloseTo(0.2);
  });

  it('leaves unknown models unpriced unless config adds them', () => {
    const mine = {provider: 'codex' as const, model: 'my-model'};
    expect(requestCost(mine, {input: 1000, cached: 0, output: 0})).toBeUndefined();
    setPriceOverrides(() => ({'codex:my-model': {input: 1, cached: 0.1, output: 2}}));
    expect(requestCost(mine, {input: 1_000_000, cached: 0, output: 1_000_000})).toBeCloseTo(3);
  });

  it('adds counts, keeping usd unset until something has a price', () => {
    expect(addTokens({input: 1, cached: 0, output: 1}, {input: 2, cached: 1, output: 0})).toEqual({input: 3, cached: 1, output: 1});
    expect(addTokens({input: 1, cached: 0, output: 1, usd: 0.5}, {input: 2, cached: 1, output: 0})).toEqual({input: 3, cached: 1, output: 1, usd: 0.5});
    expect([formatUsd(0.004), formatUsd(0), formatUsd(12.345)]).toEqual(['<$0.01', '$0.00', '$12.35']);
  });
});
