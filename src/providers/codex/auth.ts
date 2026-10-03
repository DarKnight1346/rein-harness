import type {Account, AccountStatus, LoginEvent, LoginFlow, ProviderAuth} from '../types.js';
import {EventQueue, openBrowser} from '../../util/proc.js';
import {AppServerClient} from './appServer.js';

type GetAccountResponse = {
  account: {type: 'chatgpt'; email: string | null; planType: string} | {type: string} | null;
};

/** `codex login status` claims "Logged in" even with a dead refresh token; `account/read` is the truth. */
export function toStatus(res: GetAccountResponse): AccountStatus {
  const acct = res.account;
  if (!acct) return {loggedIn: false};
  if (acct.type !== 'chatgpt') return {loggedIn: false, error: `unsupported auth type: ${acct.type}`};
  const {email, planType} = acct as {email: string | null; planType: string};
  return {loggedIn: true, email: email ?? undefined, plan: planType};
}

async function withClient<T>(account: Account, fn: (c: AppServerClient) => Promise<T>): Promise<T> {
  const client = await AppServerClient.start(account);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export const codexAuth: ProviderAuth = {
  id: 'codex',

  async status(account) {
    try {
      return await withClient(account, async (c) =>
        toStatus(await c.request<GetAccountResponse>('account/read', {refreshToken: true})),
      );
    } catch (err) {
      return {loggedIn: false, error: (err as Error).message};
    }
  },

  login(account): LoginFlow {
    const events = new EventQueue<LoginEvent>();
    let client: AppServerClient | undefined;
    let loginId: string | undefined;
    let cancelled = false;

    void (async () => {
      try {
        client = await AppServerClient.start(account);
        if (cancelled) return;
        const completed = client.waitFor('account/login/completed');
        const res = await client.request<{loginId: string; authUrl: string}>('account/login/start', {type: 'chatgpt'});
        loginId = res.loginId;
        events.push({type: 'url', url: res.authUrl});
        openBrowser(res.authUrl);
        const done = await completed;
        if (cancelled) return;
        if (!done.success) {
          events.push({type: 'error', message: done.error ?? 'login failed'});
        } else {
          const status = toStatus(await client.request<GetAccountResponse>('account/read', {refreshToken: false}));
          events.push(status.loggedIn ? {type: 'done', status} : {type: 'error', message: 'login completed but no account'});
        }
      } catch (err) {
        if (!cancelled) events.push({type: 'error', message: (err as Error).message});
      } finally {
        client?.close();
        events.end();
      }
    })();

    return {
      events,
      submitCode() {
        // Codex completes via a localhost callback; nothing to paste.
      },
      cancel() {
        cancelled = true;
        if (client && loginId) void client.request('account/login/cancel', {loginId}).catch(() => {});
        setTimeout(() => client?.close(), 500);
        events.end();
      },
    };
  },

  async logout(account) {
    if (account.imported || account.home === null) {
      throw new Error('refusing to log out an imported login; unregister it instead');
    }
    await withClient(account, (c) => c.request('account/logout'));
  },
};
