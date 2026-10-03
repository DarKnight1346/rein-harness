import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {usageStore} from '../../store/usage.js';
import {EventQueue, run} from '../../util/proc.js';
import {accountEnv} from '../env.js';
import type {ModelInfo, ProviderAdapter} from '../types.js';
import {claudeAuth} from './auth.js';
import {ClaudeSession, claudeBin, claudeOneShot} from './session.js';

/**
 * Context windows are defaults; the real value is learned from each result's
 * `modelUsage.contextWindow` (verified: haiku 4.5 = 200k, sonnet 5.5 = 1M).
 * Claude Code has no model-list command; these are its documented aliases (always the latest
 * model of each family). Tier = relative cost (1 = cheapest).
 */
export const CLAUDE_MODELS: ModelInfo[] = [
  {provider: 'claude', id: 'haiku', label: 'Haiku', description: 'Fastest and cheapest; simple questions, short edits, classification.', tier: 1, contextWindow: 200_000},
  {provider: 'claude', id: 'sonnet', label: 'Sonnet', description: 'Balanced; everyday coding, writing and analysis.', tier: 3, contextWindow: 1_000_000, isDefault: true},
  {provider: 'claude', id: 'opus', label: 'Opus', description: 'Deep reasoning; hard bugs, architecture, long multi-step work.', tier: 5, contextWindow: 1_000_000},
  {provider: 'claude', id: 'fable', label: 'Fable', description: 'Most capable; the hardest, highest-stakes problems.', tier: 6, contextWindow: 1_000_000},
];

export const claudeAdapter: ProviderAdapter = {
  ...claudeAuth,

  async listModels() {
    return CLAUDE_MODELS;
  },

  async readUsage(account) {
    // Claude only reports usage alongside a request (rate_limit_event); serve the cache.
    return usageStore.get(account.id);
  },

  async refreshUsage(account) {
    // A tiny haiku request in a fresh process always yields one rate_limit_event.
    await claudeOneShot({account, model: 'haiku', system: 'Reply with exactly: ok', prompt: 'ok', timeoutMs: 45_000});
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
