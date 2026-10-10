import {EventEmitter} from 'node:events';
import type {Account} from '../providers/types.js';
import {loadAccounts} from '../store/accounts.js';
import {CodexAppsBridge, type AppTool} from './bridge.js';
import {forgetPet, loadPetFrames, STATES, type PetFrames, type PetState} from './sprite.js';

/**
 * Pets: the animated companion from the ChatGPT and Codex apps, in Rein. The one you picked there
 * (or with /pet) sits at the bottom of the sidebar and reacts to the agent the way it does in those
 * apps: running while it works, waiting when it needs you, failed on an error, review when a turn
 * is done, waving hello. Pets live in your ChatGPT account, so they need a Codex account here.
 */
export type PetInfo = {id: string; name: string; description: string; custom: boolean; active: boolean};
/** What the agent is doing, as the pet shows it. */
export type Activity = 'idle' | 'working' | 'waiting' | 'failed' | 'done' | 'hello';

/** Pixels across (characters in the sidebar). */
export const PET_WIDTH = 24;
/** One-off reactions play for about this long before the pet settles back to idle. */
const SETTLE_MS = 4000;

export class Pets extends EventEmitter {
  pet: PetInfo | undefined;
  frames: PetFrames | undefined;
  state: PetState = 'idle';
  /** Why there's no pet on screen (shown by /pet). */
  note: string | undefined;
  readonly bridge: CodexAppsBridge;
  private codex: Account | undefined;
  private settle: NodeJS.Timeout | undefined;

  constructor(private readonly enabled: () => boolean = () => true, bridge?: CodexAppsBridge) {
    super();
    this.bridge = bridge ?? new CodexAppsBridge(() => this.codex);
  }

  /** Find the active pet in your account and load its frames (in the background at startup). */
  async refresh(): Promise<void> {
    if (!this.enabled()) return this.clear('Pets are off (/settings → General → Pet).');
    this.codex = (await loadAccounts()).accounts.find((a) => a.provider === 'codex');
    if (!this.codex) return this.clear('Pets come from your ChatGPT account: sign in a Codex account (/login) to bring yours.');
    const pets = await this.list();
    const active = pets.find((p) => p.active);
    if (!active) return this.clear('No pet is selected: /pet <name> picks one.');
    const link = await this.bridge.call('pets.get_pet_download_link', {pet_id: active.id});
    const url = link.structured?.spritesheet_url;
    if (!link.ok || typeof url !== 'string') return this.clear(`Couldn't get ${active.name}'s artwork: ${link.text || 'no download link'}`);
    // Custom pets' artwork can change; built-in sheets don't.
    if (active.custom) forgetPet(active.id);
    const frames = await loadPetFrames(active.id, url, PET_WIDTH);
    if (!frames) return this.clear(`${active.name}'s artwork is WebP, and nothing here converts it (install libwebp's dwebp, ImageMagick or ffmpeg).`);
    this.pet = active;
    this.frames = frames;
    this.note = undefined;
    this.emit('change');
  }

  /** Every pet you have (built-in and custom), across pages. */
  async list(): Promise<PetInfo[]> {
    const out: PetInfo[] = [];
    let cursor: string | null = null;
    let activeId: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.bridge.call('pets.list_pets', cursor ? {cursor} : {});
      if (!r.ok) throw new Error(r.text || 'list_pets failed');
      const s = r.structured ?? {};
      activeId = s.active_pet_id ?? activeId;
      for (const p of s.pets ?? []) out.push({id: String(p.id), name: String(p.name ?? p.id), description: String(p.description ?? ''), custom: !!p.is_custom, active: !!p.is_active});
      cursor = s.cursor ?? null;
      if (!cursor) break;
    }
    return out.map((p) => ({...p, active: p.active || p.id === activeId}));
  }

  /** Pick a pet (by id or name), or `default` for none; then show it. */
  async select(which: string): Promise<PetInfo | undefined> {
    const pets = which === 'default' ? [] : await this.list();
    const q = which.toLowerCase();
    const pick = which === 'default' ? undefined : (pets.find((p) => p.id.toLowerCase() === q) ?? pets.find((p) => p.name.toLowerCase() === q) ?? pets.find((p) => p.name.toLowerCase().startsWith(q)));
    if (which !== 'default' && !pick) throw new Error(`No pet called "${which}". /pet lists yours.`);
    const r = await this.bridge.call('pets.select_pet', {pet_id: pick?.id ?? 'default'});
    if (!r.ok) throw new Error(r.text || 'select_pet failed');
    await this.refresh();
    return pick;
  }

  /** The agent's activity → the pet's animation (reactions settle back to idle). */
  setActivity(a: Activity): void {
    const state: PetState = {idle: 'idle', working: 'running', waiting: 'waiting', failed: 'failed', done: 'review', hello: 'waving'}[a] as PetState;
    clearTimeout(this.settle);
    if (a === 'failed' || a === 'done' || a === 'hello') {
      this.settle = setTimeout(() => this.setState('idle'), SETTLE_MS);
      this.settle.unref?.();
    }
    this.setState(state);
  }

  private setState(s: PetState): void {
    if (s === this.state) return;
    this.state = s;
    this.emit('state', s);
  }

  private clear(note: string): void {
    const had = !!this.pet;
    this.pet = undefined;
    this.frames = undefined;
    this.note = note;
    if (had) this.emit('change');
  }

  /** The pets tools of your ChatGPT account (so the pets skills work with any model in Rein). */
  appTools(): Promise<AppTool[]> {
    return this.codex ? this.bridge.tools('pets.') : Promise.resolve([]);
  }

  close(): void {
    clearTimeout(this.settle);
    this.bridge.close();
  }
}

/** How long each frame shows, per state: idle breathes slowly, work is brisk. */
export const FRAME_MS: Record<PetState, number> = Object.fromEntries(Object.keys(STATES).map((s) => [s, s === 'idle' ? 220 : s === 'waiting' ? 180 : 130])) as Record<PetState, number>;
