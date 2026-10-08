import {spawn} from '../../util/platform.js';
import readline from 'node:readline';
import {usageStore} from '../../store/usage.js';
import {EventQueue, run} from '../../util/proc.js';
import {accountEnv} from '../env.js';
import path from 'node:path';
import {readJson, writeJson} from '../../store/json.js';
import {paths} from '../../store/paths.js';
import {tierFrom} from '../tier.js';
import type {Account, ModelInfo, ProviderAdapter} from '../types.js';
import {claudeAuth} from './auth.js';
import {ClaudeSession, claudeBin, claudeOneShot} from './session.js';

/** Context window until the real one is learned from a result's `modelUsage.contextWindow`. */
const UNKNOWN_WINDOW = 200_000;
/** The model list is asked of the CLI at most this often per account. */
const MODELS_TTL_MS = 24 * 60 * 60_000;

/**
 * Models billed on two rate cards by prompt size: above the break, the whole request costs more
 * (Haiku 5.5: $0.10/$0.50 per MTok up to 100K tokens, $0.50/$2.50 above). By resolved model, so an
 * alias that moves (`haiku` was Haiku 4.5, flat-priced) gets the right one.
 */
const PRICE_BREAKS: Record<string, number> = {'claude-haiku-5-5': 100_000};

type CliModel = {value: string; resolvedModel?: string; displayName?: string; description?: string; supportedEffortLevels?: string[]};

/**
 * The account's models, as the claude CLI itself reports them (the `initialize` control request —
 * what the Agent SDK's supportedModels() uses): names, descriptions, effort levels, the default.
 * Nothing is hardcoded; the cost tier comes from each description.
 */
export async function fetchClaudeModels(account: Account): Promise<ModelInfo[]> {
  const child = spawn(claudeBin(), ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--system-prompt', 'Model list.', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'], {
    env: accountEnv(account),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    const models = await new Promise<CliModel[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('claude did not report its models')), 30_000);
      child.on('error', reject);
      readline.createInterface({input: child.stdout}).on('line', (line) => {
        try {
          const e = JSON.parse(line);
          if (e.type !== 'control_response') return;
          clearTimeout(timer);
          resolve((e.response?.response ?? e.response)?.models ?? []);
        } catch {}
      });
      child.stdin.write(JSON.stringify({type: 'control_request', request_id: 'rein-models', request: {subtype: 'initialize'}}) + '\n');
    });
    const def = models.find((m) => m.value === 'default')?.resolvedModel;
    let defaultMarked = false;
    return models
      .filter((m) => m.value && m.value !== 'default')
      .map((m): ModelInfo => {
        const isDefault = !defaultMarked && !!def && m.resolvedModel === def;
        if (isDefault) defaultMarked = true;
        return {
          provider: 'claude',
          id: m.value,
          label: m.displayName ?? m.value,
          description: m.description,
          tier: tierFrom(m.description),
          contextWindow: UNKNOWN_WINDOW,
          isDefault,
          efforts: m.supportedEffortLevels?.length ? m.supportedEffortLevels : undefined,
          priceBreak: m.resolvedModel ? PRICE_BREAKS[m.resolvedModel] : undefined,
        };
      });
  } finally {
    child.kill();
  }
}

const modelsCache = (account: Account) => path.join(paths.state(), `claude-models-${account.id}.json`);

/** Cached per account; refreshed in the background once a day (and fetched on first use). */
async function listClaudeModels(account: Account): Promise<ModelInfo[]> {
  const cached = await readJson<{at: number; models: ModelInfo[]} | undefined>(modelsCache(account), undefined).catch(() => undefined);
  const refresh = async () => {
    const models = await fetchClaudeModels(account);
    if (models.length) await writeJson(modelsCache(account), {at: Date.now(), models});
    return models;
  };
  if (cached?.models?.length) {
    if (Date.now() - cached.at > MODELS_TTL_MS) void refresh().catch(() => {});
    return cached.models;
  }
  return refresh();
}

export const claudeAdapter: ProviderAdapter = {
  ...claudeAuth,

  async listModels(account) {
    return listClaudeModels(account);
  },

  async readUsage(account) {
    // Claude only reports usage alongside a request (rate_limit_event); serve the cache.
    return usageStore.get(account.id);
  },

  async refreshUsage(account) {
    // A tiny haiku request in a fresh process always yields one rate_limit_event.
    // The cheapest model this account offers (from the CLI's own list).
    const cheapest = [...(await listClaudeModels(account))].sort((a, b) => a.tier - b.tier)[0];
    if (!cheapest) return usageStore.get(account.id);
    await claudeOneShot({account, model: cheapest.id, system: 'Reply with exactly: ok', prompt: 'ok', timeoutMs: 45_000});
    return usageStore.get(account.id);
  },

  async openSession(opts) {
    const {tools, ...rest} = opts;
    const binding = tools ? {socket: await tools.listen(), names: tools.allowed ?? tools.tools.map((t) => t.name), proxy: tools.proxy} : undefined;
    return new ClaudeSession({...rest, persist: true, tools: binding});
  },

  async fork({tools, nativeId, ...rest}) {
    // The fork still needs the tool definitions (its history contains tool calls); only read-only
    // tools are allowed, and it isn't persisted.
    const binding = tools ? {socket: await tools.listen(), names: tools.allowed ?? tools.tools.map((t) => t.name), proxy: tools.proxy} : undefined;
    return new ClaudeSession({...rest, resumeId: nativeId, fork: true, persist: false, tools: binding});
  },

  oneShot: claudeOneShot,

  async version() {
    try {
      const res = await run(claudeBin(), ['--version'], {timeoutMs: 15_000});
      return res.stdout.trim().split(/\s+/)[0] || undefined;
    } catch {
      return undefined;
    }
  },

  update() {
    return streamCommand(claudeBin(), ['update']);
  },

  shutdown() {},
};

/** Run a command and yield its output lines (stdout + stderr), then an exit line. */
export function streamCommand(cmd: string, args: string[], env?: NodeJS.ProcessEnv): AsyncIterable<string> {
  const q = new EventQueue<string>();
  const child = spawn(cmd, args, {env: env ?? accountEnv({id: 'update', provider: 'claude', home: null, imported: true}), stdio: ['ignore', 'pipe', 'pipe']});
  readline.createInterface({input: child.stdout}).on('line', (l) => q.push(l));
  readline.createInterface({input: child.stderr}).on('line', (l) => q.push(l));
  child.on('error', (err) => {
    q.push(`! ${err.message}`);
    q.end();
  });
  child.on('close', (code) => {
    q.push(code === 0 ? '✓ done' : `! exited with code ${code}`);
    q.end();
  });
  return q;
}
