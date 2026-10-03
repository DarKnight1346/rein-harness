import {spawn} from '../../util/platform.js';
import {mkdir} from 'node:fs/promises';
import {accountEnv} from '../env.js';
import type {Account, AccountStatus, LoginEvent, LoginFlow, ProviderAuth} from '../types.js';
import {EventQueue, run} from '../../util/proc.js';

const claudeBin = () => process.env.REIN_CLAUDE_BIN ?? 'claude';

/**
 * `claude auth status --json` exits 1 when logged out, and for a fresh config dir prints
 * "configuration file not found" text before the JSON — so parse from the first `{`.
 */
export function parseAuthStatus(stdout: string): AccountStatus {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return {loggedIn: false, error: 'no status JSON from claude'};
  let data: {loggedIn?: boolean; email?: string; subscriptionType?: string};
  try {
    data = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return {loggedIn: false, error: 'unparseable status JSON from claude'};
  }
  if (!data.loggedIn) return {loggedIn: false};
  return {loggedIn: true, email: data.email, plan: data.subscriptionType};
}

const URL_RE = /https:\/\/\S+\/oauth\/authorize\S*/;

export const claudeAuth: ProviderAuth = {
  id: 'claude',

  async status(account) {
    try {
      const res = await run(claudeBin(), ['auth', 'status', '--json'], {env: accountEnv(account), timeoutMs: 20_000});
      return parseAuthStatus(res.stdout);
    } catch (err) {
      return {loggedIn: false, error: (err as Error).message};
    }
  },

  login(account): LoginFlow {
    const events = new EventQueue<LoginEvent>();
    let child: ReturnType<typeof spawn> | undefined;
    let cancelled = false;

    void (async () => {
      if (account.home) await mkdir(account.home, {recursive: true, mode: 0o700});
      if (cancelled) return events.end();
      // claude opens the browser itself; we still surface the URL in case it didn't.
      child = spawn(claudeBin(), ['auth', 'login', '--claudeai'], {env: accountEnv(account), stdio: ['pipe', 'pipe', 'pipe']});
      let sawUrl = false;
      let askedCode = false;
      const onData = (d: Buffer) => {
        const text = d.toString();
        const url = !sawUrl && text.match(URL_RE)?.[0];
        if (url) {
          sawUrl = true;
          events.push({type: 'url', url});
        }
        if (!askedCode && /paste code/i.test(text)) {
          askedCode = true;
          events.push({type: 'needsCode'});
        }
        events.push({type: 'output', text});
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.on('error', (err) => {
        events.push({type: 'error', message: err.message});
        events.end();
      });
      child.on('close', async (code) => {
        if (cancelled) return events.end();
        const status = await claudeAuth.status(account);
        if (status.loggedIn) events.push({type: 'done', status});
        else events.push({type: 'error', message: `claude auth login exited with code ${code}`});
        events.end();
      });
    })();

    return {
      events,
      submitCode(code) {
        child?.stdin?.write(code.trim() + '\n');
      },
      cancel() {
        cancelled = true;
        child?.kill('SIGTERM');
        events.end();
      },
    };
  },

  async logout(account) {
    if (account.imported || account.home === null) {
      throw new Error('refusing to log out an imported login; unregister it instead');
    }
    await run(claudeBin(), ['auth', 'logout'], {env: accountEnv(account), timeoutMs: 20_000});
  },
};
