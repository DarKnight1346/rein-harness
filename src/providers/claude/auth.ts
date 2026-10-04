import {spawn} from '../../util/platform.js';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  let data: {loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string; apiProvider?: string; orgName?: string};
  try {
    data = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return {loggedIn: false, error: 'unparseable status JSON from claude'};
  }
  if (!data.loggedIn) return {loggedIn: false};
  // API accounts: a Console key ("api_key"), or Claude on a cloud ("third_party": bedrock, vertex…).
  if (data.authMethod === 'api_key') return {loggedIn: true, email: data.email, plan: 'API · Console'};
  if (data.authMethod === 'third_party') return {loggedIn: true, plan: `API · ${({bedrock: 'Bedrock', vertex: 'Vertex', foundry: 'Foundry'} as Record<string, string>)[data.apiProvider ?? ''] ?? data.apiProvider ?? 'cloud'}`};
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
    if (account.api === 'bedrock' || account.api === 'vertex') return checkCloud(account);
    const events = new EventQueue<LoginEvent>();
    let child: ReturnType<typeof spawn> | undefined;
    let cancelled = false;

    void (async () => {
      if (account.home) await mkdir(account.home, {recursive: true, mode: 0o700});
      if (cancelled) return events.end();
      // claude opens the browser itself; we still surface the URL in case it didn't. A Console
      // (API) account logs in the same way and the CLI keeps its key for this config dir.
      child = spawn(claudeBin(), ['auth', 'login', account.api === 'console' ? '--console' : '--claudeai'], {env: accountEnv(account), stdio: ['pipe', 'pipe', 'pipe']});
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

/**
 * Bedrock / Vertex have no CLI login (credentials come from AWS / Google Cloud): "logging in"
 * checks the setup works with one tiny request through the CLI.
 */
function checkCloud(account: Account): LoginFlow {
  const events = new EventQueue<LoginEvent>();
  let cancelled = false;
  let child: ReturnType<typeof spawn> | undefined;
  void (async () => {
    if (account.home) await mkdir(account.home, {recursive: true, mode: 0o700});
    // The CLI waits silently on credentials it can't resolve: catch the obvious problems first.
    const problem = cloudSetupProblem(account);
    if (problem) {
      events.push({type: 'error', message: problem});
      return events.end();
    }
    events.push({type: 'output', text: `Checking Claude on ${account.api === 'bedrock' ? 'Amazon Bedrock' : 'Google Vertex AI'} with your credentials…`});
    child = spawn(claudeBin(), ['-p', 'Reply with exactly: ok', '--output-format', 'json', '--no-session-persistence', '--tools', ''], {env: accountEnv(account), stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill('SIGTERM');
    }, 60_000);
    child.on('close', async () => {
      clearTimeout(timer);
      if (cancelled) return events.end();
      let ok = false;
      let message =
        timedOut ? `no answer within 60 s. Check the ${account.api === 'bedrock' ? 'region, AWS profile and credentials (aws sts get-caller-identity)' : 'project, region and credentials (gcloud auth application-default login)'}, and that Claude is enabled for this account in ${account.api === 'bedrock' ? 'Bedrock model access' : 'Vertex AI Model Garden'}.`
        : out.trim().split('\n').at(-1) || 'no response';
      try {
        const r = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
        ok = r.is_error === false;
        if (!ok) message = String(r.result ?? r.error ?? message);
      } catch {}
      if (ok) events.push({type: 'done', status: await claudeAuth.status(account)});
      else events.push({type: 'error', message: `the check request failed: ${message.slice(0, 300)}`});
      events.end();
    });
  })();
  return {
    events,
    submitCode() {},
    cancel() {
      cancelled = true;
      child?.kill('SIGTERM');
      events.end();
    },
  };
}

/** Obvious Bedrock / Vertex setup problems, found without a request (the CLI would just hang). */
export function cloudSetupProblem(account: Account, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string | undefined {
  const c = account.apiConfig ?? {};
  if (account.api === 'bedrock') {
    if (!c.region) return 'an AWS region is required (e.g. us-east-1)';
    if (c.profile) {
      const files = [env.AWS_CONFIG_FILE ?? path.join(home, '.aws', 'config'), env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(home, '.aws', 'credentials')];
      const text = files.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')).join('\n');
      if (!new RegExp(`^\\[(profile )?${c.profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm').test(text)) return `AWS profile "${c.profile}" isn't in ~/.aws/config or ~/.aws/credentials`;
    }
  }
  if (account.api === 'vertex') {
    if (!c.projectId) return 'a Google Cloud project ID is required';
    const adc = env.GOOGLE_APPLICATION_CREDENTIALS ?? path.join(home, '.config', 'gcloud', 'application_default_credentials.json');
    if (!existsSync(adc)) return 'no Google Cloud credentials found: run `gcloud auth application-default login` (or set GOOGLE_APPLICATION_CREDENTIALS)';
  }
  return undefined;
}
