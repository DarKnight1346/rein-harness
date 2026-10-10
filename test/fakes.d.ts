import type { Account, ChatEvent, ModelInfo, OneShotOpts, ProviderAdapter, ProviderId, SessionOpts } from '../src/providers/types.js';
export declare function tempHome(accounts: Account[]): Promise<string>;
export declare const acct: (provider: ProviderId, id: string, email?: string) => Account;
/** Scripted reply for one turn: text chunks then done, or an error. */
export type Script = (prompt: string, ctx: {
    accountId: string;
    model: string;
}) => ChatEvent[];
export type FakeLog = {
    opened: SessionOpts[];
    prompts: {
        accountId: string;
        model: string;
        prompt: string;
    }[];
    oneShots: OneShotOpts[];
    setModel: string[];
};
export declare function fakeAdapter(provider: ProviderId, models: ModelInfo[], script: Script, oneShot?: (o: OneShotOpts) => string): {
    adapter: ProviderAdapter;
    log: FakeLog;
};
export declare function install(provider: ProviderId, adapter: ProviderAdapter): void;
export declare const reply: (text: string) => ChatEvent[];
export declare const CLAUDE_FAKE_MODELS: ModelInfo[];
export declare const CODEX_FAKE_MODELS: ModelInfo[];
