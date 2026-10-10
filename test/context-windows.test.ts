import {mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {adapters} from '../src/providers/index.js';
import {contextWindows} from '../src/providers/codex/catalog.js';
import type {Account} from '../src/providers/types.js';
import {ModelCatalog} from '../src/router/catalog.js';

beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
});

describe('context windows', () => {
  it("Codex models get the usable window: Codex's own margin taken off", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({models: [
      {slug: 'gpt-a', context_window: 272_000, effective_context_window_percent: 95},
      {slug: 'gpt-b', context_window: 400_000},
      {slug: 'gpt-c'},
    ]}));
    const w = await contextWindows({id: 'codex-1', provider: 'codex', home, imported: false});
    expect(w.get('gpt-a')).toBe(258_400); // what Codex reports as model_context_window
    expect(w.get('gpt-b')).toBe(400_000);
    expect(w.get('gpt-c')).toBe(128_000);
  });

  describe('Claude models, probed once', () => {
    const original = adapters.claude.probeContextWindow;
    afterEach(() => {
      adapters.claude.probeContextWindow = original;
    });
    const setup = (accounts: Account[]) => {
      const cat = new ModelCatalog() as any;
      cat.accounts = accounts;
      cat.models = new Map([
        ['claude:fable', {provider: 'claude', id: 'fable', label: 'Fable', tier: 3, contextWindow: 200_000, accountIds: accounts.map((a) => a.id)}],
        ['claude:haiku', {provider: 'claude', id: 'haiku', label: 'Haiku', tier: 1, contextWindow: 200_000, accountIds: accounts.map((a) => a.id)}],
      ]);
      return cat as ModelCatalog;
    };

    it('asks each unknown model once and keeps the answer', async () => {
      const asked: string[] = [];
      adapters.claude.probeContextWindow = async (_a, model) => (asked.push(model), model === 'fable' ? 1_000_000 : 200_000);
      const cat = setup([{id: 'claude-1', provider: 'claude', home: null, imported: true}]);
      cat.learnContextWindow({provider: 'claude', model: 'haiku'}, 200_000); // already known from use
      await cat.probeWindows();
      await cat.probeWindows();
      expect(asked).toEqual(['fable']);
      expect(cat.get({provider: 'claude', model: 'fable'})?.contextWindow).toBe(1_000_000);
    });

    it('asks again when an alias starts pointing at a new model', async () => {
      const asked: string[] = [];
      adapters.claude.probeContextWindow = async (_a, model) => (asked.push(model), 1_000_000);
      const cat = setup([{id: 'claude-1', provider: 'claude', home: null, imported: true}]);
      (cat as any).models.get('claude:haiku').resolved = 'claude-haiku-4-5';
      cat.learnContextWindow({provider: 'claude', model: 'haiku'}, 200_000); // learned for Haiku 4.5
      (cat as any).models.get('claude:haiku').resolved = 'claude-haiku-5-5'; // the alias moved
      await cat.probeWindows();
      expect(asked).toContain('haiku');
      expect(cat.get({provider: 'claude', model: 'haiku'})?.contextWindow).toBe(1_000_000);
    });

    it('never spends a pay-per-use API account on it', async () => {
      const asked: string[] = [];
      adapters.claude.probeContextWindow = async (a) => (asked.push(a.id), 1_000_000);
      const cat = setup([{id: 'console-1', provider: 'claude', home: null, imported: false, api: 'console'}]);
      await cat.probeWindows();
      expect(asked).toEqual([]);
      expect(cat.get({provider: 'claude', model: 'fable'})?.contextWindow).toBe(200_000);
    });
  });
});
