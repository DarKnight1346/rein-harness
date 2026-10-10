import {mkdtemp, mkdir, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {parseAuthStatus} from '../src/providers/claude/auth.js';
import {toStatus} from '../src/providers/codex/auth.js';
import {accountEnv} from '../src/providers/env.js';
import {deleteOwnedHome, loadAccounts, newOwnedAccount, nextAccountId, removeAccount, upsertAccount} from '../src/store/accounts.js';
import {parseInput} from '../src/commands/index.js';
import {splitLiveTail} from '../src/ui/liveTail.js';
import type {Account} from '../src/providers/types.js';

beforeEach(async () => {
  process.env.REIN_HOME = await mkdtemp(path.join(os.tmpdir(), 'rein-test-'));
});

describe('accountEnv', () => {
  const base = {PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/x', OPENAI_API_KEY: 'o', CODEX_HOME: '/y'};
  it('leaves the home var unset for default (imported) dirs', () => {
    const env = accountEnv({id: 'a', provider: 'claude', home: null, imported: true}, base);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });
  it('sets the home var for owned dirs and strips provider keys', () => {
    const env = accountEnv({id: 'b', provider: 'codex', home: '/rein/codex-1', imported: false}, base);
    expect(env.CODEX_HOME).toBe('/rein/codex-1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe('claude status parsing', () => {
  it('parses JSON preceded by warning text', () => {
    const out = 'Claude configuration file not found at: /x\n\n{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}\n';
    expect(parseAuthStatus(out)).toEqual({loggedIn: true, email: 'a@b.c', plan: 'max'});
  });
  it('treats loggedIn:false as signed out', () => {
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({loggedIn: false});
  });
  it('reports missing JSON', () => {
    expect(parseAuthStatus('boom').loggedIn).toBe(false);
  });
});

describe('codex status', () => {
  it('maps account/read', () => {
    expect(toStatus({account: null})).toEqual({loggedIn: false});
    expect(toStatus({account: {type: 'chatgpt', email: 'x@y.z', planType: 'free'}})).toEqual({loggedIn: true, email: 'x@y.z', plan: 'free'});
  });
});

describe('account registry', () => {
  it('upserts, removes and numbers ids', async () => {
    const a = newOwnedAccount('claude', []);
    expect(a.id).toBe('claude-1');
    await upsertAccount(a);
    await upsertAccount({...a, email: 'e@x'});
    expect((await loadAccounts()).accounts).toEqual([{...a, email: 'e@x'}]);
    expect(nextAccountId('claude', [a])).toBe('claude-2');
    await removeAccount(a.id);
    expect((await loadAccounts()).accounts).toEqual([]);
  });

  it('deletes owned homes but never imported or outside dirs', async () => {
    const owned = newOwnedAccount('codex', []);
    await mkdir(owned.home!, {recursive: true});
    await deleteOwnedHome(owned);
    await expect(stat(owned.home!)).rejects.toThrow();

    const outside = await mkdtemp(path.join(os.tmpdir(), 'not-rein-'));
    await expect(deleteOwnedHome({...owned, home: outside})).rejects.toThrow(/refusing/);
    await deleteOwnedHome({...owned, home: outside, imported: true}); // no-op
    expect((await stat(outside)).isDirectory()).toBe(true);
    const imported: Account = {id: 'd', provider: 'claude', home: null, imported: true};
    await deleteOwnedHome(imported); // no-op, no throw
  });
});

describe('parseInput', () => {
  it('parses commands, unknowns and text', () => {
    expect(parseInput('  ')).toBeUndefined();
    expect(parseInput('/LOGIN')).toEqual({kind: 'command', name: 'login', args: ''});
    expect(parseInput('/model auto')).toEqual({kind: 'command', name: 'model', args: 'auto'});
    expect(parseInput('/nope')).toEqual({kind: 'unknown', name: 'nope'});
    expect(parseInput('hello')).toEqual({kind: 'text', text: 'hello'});
  });
});

describe('splitLiveTail', () => {
  it('keeps short text fully live', () => {
    expect(splitLiveTail('a\nb', 5, 80)).toEqual({committed: '', live: 'a\nb'});
  });
  it('counts wrapped rows, not newlines', () => {
    const long = 'x'.repeat(250); // 4 rows at 80 cols
    const text = ['one', long, 'tail'].join('\n');
    const {committed, live} = splitLiveTail(text, 5, 80);
    expect(committed).toBe('one');
    expect(live).toBe(`${long}\ntail`);
  });
  it('always keeps the last (growing) line live', () => {
    const {committed, live} = splitLiveTail('a\nb\n' + 'y'.repeat(1000), 2, 80);
    expect(committed).toBe('a\nb');
    expect(live).toBe('y'.repeat(1000));
  });
});

describe('suggestCommands', () => {
  it('filters until a space is typed, prefix matches first', async () => {
    const {suggestCommands, COMMANDS} = await import('../src/commands/index.js');
    // A bare `/`: everyday commands only (no specialist commands, variants or diagnostics).
    expect(suggestCommands('/')).toHaveLength(COMMANDS.filter((c) => c.listed !== false).length);
    expect(suggestCommands('/').map((c) => c.name).slice(0, 3)).toEqual(['model', 'goal', 'btw']);
    expect(suggestCommands('/').map((c) => c.name)).not.toContain('tui');
    expect(suggestCommands('/tu').map((c) => c.name)[0]).toBe('tui'); // typed: found
    expect(suggestCommands('/u').map((c) => c.name).slice(0, 2)).toEqual(['usage', 'update']);
    expect(suggestCommands('/model ')).toEqual([]);
    expect(suggestCommands('hello')).toEqual([]);
    expect(suggestCommands('/zzz')).toEqual([]);
  });

  it('matches fuzzily, best match first', async () => {
    const {suggestCommands} = await import('../src/commands/index.js');
    const names = (q: string) => suggestCommands(q).map((c) => c.name);
    expect(names('/cmpct')[0]).toBe('compact'); // letters in order
    expect(names('/plan')[0]).toBe('goal:plan'); // the start of a word
    expect(names('/sett')[0]).toBe('settings');
    expect(names('/model')[0]).toBe('model'); // exact beats everything
  });

  it('lists specialist commands only once typed, and says where moved ones went', async () => {
    const {suggestCommands} = await import('../src/commands/index.js');
    const {movedMessage} = await import('../src/commands/moved.js');
    expect(suggestCommands('/').map((c) => c.name)).not.toContain('stats');
    expect(suggestCommands('/stat').map((c) => c.name)[0]).toBe('stats');
    expect(movedMessage('coverage')).toMatch(/Test quality item: \/marketplace install quality/);
    expect(movedMessage('services')).toMatch(/install system/);
    expect(movedMessage('model')).toBeUndefined();
  });

  it('ranks skills with commands, and matches their aliases', async () => {
    const {suggestCommands} = await import('../src/commands/index.js');
    const skill = {name: 'review-deep', description: 'Deep review', aliases: ['rd'], source: 'builtin'} as any;
    expect(suggestCommands('/rvwdeep', [skill])[0]?.name).toBe('review-deep');
    expect(suggestCommands('/rd', [skill])[0]?.name).toBe('review-deep');
  });
});

describe('reflowedRows', () => {
  it('counts rows a frame occupies after the terminal rewraps it narrower', async () => {
    const {reflowedRows} = await import('../src/ui/resizeFix.js');
    const frame = ['╭' + '─'.repeat(98) + '╮', '│ > hi' + ' '.repeat(93) + '│', '╰' + '─'.repeat(98) + '╯', '  rein · Haiku', ''].join('\n');
    expect(reflowedRows(frame, 100)).toBe(4);
    expect(reflowedRows(frame, 60)).toBe(2 + 2 + 2 + 1);
    expect(reflowedRows(frame, 40)).toBe(3 + 3 + 3 + 1);
  });
});
