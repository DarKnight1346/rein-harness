import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {AppServerClient, RpcRequestError} from '../src/providers/codex/appServer.js';
import {codexAuth} from '../src/providers/codex/auth.js';
import type {Account} from '../src/providers/types.js';

const acct = (home: string | null): Account => ({id: 'codex-1', provider: 'codex', home, imported: home === null});
let client: AppServerClient | undefined;

beforeAll(async () => {
  process.env.REIN_CODEX_BIN = path.resolve('test/fixtures/fake-codex.mjs');
  process.env.REIN_HOME = await mkdtemp(path.join(os.tmpdir(), 'rein-test-'));
  process.env.REIN_NO_BROWSER = '1';
});
afterEach(() => client?.close());

describe('AppServerClient', () => {
  it('handshakes and correlates requests', async () => {
    client = await AppServerClient.start(acct(null));
    const res = await client.request('account/read', {});
    expect(res.account.email).toBe('me@example.com');
    await expect(client.request('nope/x')).rejects.toBeInstanceOf(RpcRequestError);
  });

  it('declines server→client requests by default', async () => {
    client = await AppServerClient.start(acct(null));
    const answered = client.waitFor('test/approvalAnswered');
    await client.request('test/askApproval');
    const reply = await answered;
    expect(reply.error.code).toBe(-32601);
    expect(reply.result).toBeUndefined();
  });
});

describe('codexAuth', () => {
  it('reports status per CODEX_HOME', async () => {
    expect(await codexAuth.status(acct(null))).toEqual({loggedIn: true, email: 'me@example.com', plan: 'plus'});
    expect(await codexAuth.status(acct(path.join(process.env.REIN_HOME!, 'accounts/codex/empty')))).toEqual({loggedIn: false});
  });

  it('runs the chatgpt login flow', async () => {
    const flow = codexAuth.login(acct(null));
    const events = [];
    for await (const ev of flow.events) events.push(ev);
    expect(events[0]).toEqual({type: 'url', url: 'https://auth.example/x'});
    expect(events.at(-1)).toMatchObject({type: 'done', status: {loggedIn: true}});
  });
});
