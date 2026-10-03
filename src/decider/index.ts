import {adapters} from '../providers/index.js';
import {parseRef, type ModelRef} from '../providers/types.js';
import {catalog, toRef} from '../router/catalog.js';
import type {Config} from '../store/config.js';
import {getJevKey} from '../store/secrets.js';
import {jevBackend} from './jev.js';
import {llmBackend} from './llm.js';
import type {DeciderBackend, Decision, Entry, Questions} from './types.js';

/** Resolve a model setting (`cheapest` or a ref) to a model with a healthy account. */
export function resolveUtilityModel(setting: string, cfg: Config): ModelRef | undefined {
  if (setting !== 'cheapest' && setting !== 'jev') {
    const ref = parseRef(setting);
    if (ref && catalog.healthyAccounts(ref, cfg.maxUsedPct).length) return ref;
  }
  const m = catalog.cheapest(cfg.maxUsedPct);
  return m ? toRef(m) : undefined;
}

/** Run a one-shot prompt on a model, using its healthiest account. */
export async function completeWith(ref: ModelRef, cfg: Config, system: string, prompt: string, opts: {timeoutMs?: number; fast?: boolean} = {}): Promise<string> {
  const account = catalog.healthyAccounts(ref, cfg.maxUsedPct)[0];
  if (!account) throw new Error(`no healthy account for ${ref.model}`);
  return adapters[ref.provider].oneShot({account, model: ref.model, system, prompt, timeoutMs: opts.timeoutMs ?? 60_000, fast: opts.fast});
}

function llmFor(cfg: Config): DeciderBackend | undefined {
  const ref = resolveUtilityModel(cfg.decisionModel, cfg);
  if (!ref) return undefined;
  return llmBackend(`${ref.model} (strict prompt)`, (system, prompt) => completeWith(ref, cfg, system, prompt, {timeoutMs: 45_000, fast: true}));
}

/**
 * Ask the configured decision backend. Jev first when selected and keyed; any Jev failure falls
 * back to the LLM backend so routing never blocks on Jev availability.
 */
export async function decide(cfg: Config, state: Entry, questions: Questions): Promise<Decision> {
  if (cfg.decisionModel === 'jev') {
    const key = await getJevKey();
    if (key) {
      try {
        return await jevBackend(key, cfg.jevModel).ask(state, questions);
      } catch (err) {
        const llm = llmFor(cfg);
        if (!llm) throw err;
        const d = await llm.ask(state, questions);
        return {...d, backend: `${d.backend} (Jev failed: ${(err as Error).message})`};
      }
    }
  }
  const llm = llmFor(cfg);
  if (!llm) throw new Error('no decision model available');
  return llm.ask(state, questions);
}
