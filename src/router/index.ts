import type {ModelRef} from '../providers/types.js';
import {parseRef, refKey} from '../providers/types.js';
import type {Route} from '../session/engine.js';
import type {Transcript} from '../session/transcript.js';
import type {Config} from '../store/config.js';
import {catalog, toRef} from './catalog.js';

export type AutoRouter = (text: string, t: Transcript, current: ModelRef | undefined, exclude: ReadonlySet<string>) => Promise<Route>;

/** The configured default: explicit `defaultModel`, else the provider default. */
export function defaultRef(cfg: Config): ModelRef | undefined {
  const pinned = cfg.defaultModel ? parseRef(cfg.defaultModel) : undefined;
  if (pinned && catalog.get(pinned)) return pinned;
  const m = catalog.defaultModel(cfg.maxUsedPct);
  return m ? toRef(m) : undefined;
}

/** Chat model as configured: `auto` → auto router; a ref → that model; unset → default. */
export function makeRouter(cfg: () => Config, auto: AutoRouter) {
  return {
    async route(text: string, t: Transcript, current: ModelRef | undefined): Promise<Route> {
      const c = cfg();
      if (c.chatModel === 'auto') return auto(text, t, current, new Set());
      const fixed = c.chatModel ? parseRef(c.chatModel) : undefined;
      if (fixed) return {ref: fixed, reason: 'fixed'};
      const def = defaultRef(c);
      if (!def) throw new Error('no models available — sign in with /login');
      return {ref: def, reason: 'default'};
    },

    /**
     * Every account for `failed` is unavailable. In auto mode the auto router re-decides among the
     * remaining models; otherwise pick the healthy model closest in cost tier (no tokens spent).
     */
    async alternative(text: string, t: Transcript, failed: ModelRef, exclude: ReadonlySet<string>): Promise<ModelRef | undefined> {
      const c = cfg();
      const others = catalog.available(c.maxUsedPct, exclude).filter((m) => refKey(toRef(m)) !== refKey(failed));
      if (!others.length) return undefined;
      if (c.chatModel === 'auto') {
        const r = await auto(text, t, undefined, exclude).catch(() => undefined);
        if (r && refKey(r.ref) !== refKey(failed)) return r.ref;
      }
      const tier = catalog.get(failed)?.tier ?? 3;
      const best = others.sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier) || b.tier - a.tier)[0]!;
      return toRef(best);
    },
  };
}
