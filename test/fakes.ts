import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {adapters} from '../src/providers/index.js';
import type {Account, ChatEvent, ModelInfo, OneShotOpts, ProviderAdapter, ProviderId, ProviderSession, SessionOpts} from '../src/providers/types.js';
import {EventQueue} from '../src/util/proc.js';

export async function tempHome(accounts: Account[]): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rein-test-'));
  process.env.REIN_HOME = home;
  await writeFile(path.join(home, 'accounts.json'), JSON.stringify({version: 1, importOffered: true, accounts}));
  return home;
}

export const acct = (provider: ProviderId, id: string, email = `${id}@x`): Account => ({id, provider, home: null, imported: true, email});

/** Scripted reply for one turn: text chunks then done, or an error. */
export type Script = (prompt: string, ctx: {accountId: string; model: string}) => ChatEvent[];

export type FakeLog = {opened: SessionOpts[]; prompts: {accountId: string; model: string; prompt: string}[]; oneShots: OneShotOpts[]; setModel: string[]};

export function fakeAdapter(provider: ProviderId, models: ModelInfo[], script: Script, oneShot: (o: OneShotOpts) => string = () => 'ok'): {adapter: ProviderAdapter; log: FakeLog} {
  const log: FakeLog = {opened: [], prompts: [], oneShots: [], setModel: []};
  let n = 0;
  const adapter: ProviderAdapter = {
    id: provider,
    status: async () => ({loggedIn: true}),
    login: () => ({events: new EventQueue(), submitCode() {}, cancel() {}}),
    logout: async () => {},
    listModels: async () => models,
    readUsage: async () => undefined,
    refreshUsage: async () => undefined,
    async openSession(opts) {
      log.opened.push(opts);
      const id = `${provider}-native-${++n}`;
      const s: ProviderSession = {
        provider,
        accountId: opts.account.id,
        model: opts.model,
        nativeId: () => id,
        send(prompt) {
          log.prompts.push({accountId: opts.account.id, model: s.model, prompt});
          const q = new EventQueue<ChatEvent>();
          for (const ev of script(prompt, {accountId: opts.account.id, model: s.model})) q.push(ev);
          q.end();
          return q;
        },
        interrupt() {},
        async setModel(m) {
          log.setModel.push(m);
          s.model = m;
        },
        close() {},
      };
      return s;
    },
    async fork(opts) {
      return adapter.openSession({account: opts.account, model: opts.model, systemPrompt: opts.systemPrompt});
    },
    async oneShot(o) {
      log.oneShots.push(o);
      return oneShot(o);
    },
    version: async () => '1.0.0',
    update: () => {
      const q = new EventQueue<string>();
      q.end();
      return q;
    },
    shutdown() {},
  };
  return {adapter, log};
}

export function install(provider: ProviderId, adapter: ProviderAdapter): void {
  (adapters as Record<ProviderId, ProviderAdapter>)[provider] = adapter;
}

export const reply = (text: string): ChatEvent[] => [{type: 'text', delta: text}, {type: 'done', interrupted: false}];

export const CLAUDE_FAKE_MODELS: ModelInfo[] = [
  {provider: 'claude', id: 'haiku', label: 'Haiku', tier: 1, contextWindow: 200_000},
  {provider: 'claude', id: 'sonnet', label: 'Sonnet', tier: 3, contextWindow: 200_000, isDefault: true},
];
export const CODEX_FAKE_MODELS: ModelInfo[] = [{provider: 'codex', id: 'gpt-x', label: 'GPT-X', tier: 2, contextWindow: 128_000, isDefault: true}];
