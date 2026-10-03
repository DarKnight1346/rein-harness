import type {UsageSnapshot, UsageWindow} from '../providers/types.js';
import {readJson, writeJson} from './json.js';
import {paths} from './paths.js';
import path from 'node:path';

type UsageFile = {accounts: Record<string, UsageSnapshot>; cooldowns: Record<string, number>};

const file = () => path.join(paths.state(), 'usage.json');

/** Last-known usage per account + limit cooldowns. In-memory with write-through; subscribers re-render. */
class UsageStore {
  private data: UsageFile = {accounts: {}, cooldowns: {}};
  private loaded = false;
  private listeners = new Set<() => void>();

  async load(): Promise<void> {
    if (this.loaded) return;
    this.data = await readJson(file(), {accounts: {}, cooldowns: {}});
    this.loaded = true;
  }

  /** Drop in-memory state (tests, or after REIN_HOME changes). */
  reset(): void {
    this.data = {accounts: {}, cooldowns: {}};
    this.loaded = false;
  }

  get(accountId: string): UsageSnapshot | undefined {
    return this.data.accounts[accountId];
  }

  set(accountId: string, snap: UsageSnapshot): void {
    this.data.accounts[accountId] = snap;
    if (snap.limited) {
      const reset = maxReset(snap.windows.filter((w) => w.usedPct >= 100));
      if (reset) this.coolDown(accountId, reset);
    }
    this.changed();
  }

  /** Account unusable until `until` (epoch ms). */
  coolDown(accountId: string, until: number): void {
    this.data.cooldowns[accountId] = Math.max(this.data.cooldowns[accountId] ?? 0, until);
    this.changed();
  }

  cooldownUntil(accountId: string, now = Date.now()): number | undefined {
    const until = this.data.cooldowns[accountId];
    return until && until > now ? until : undefined;
  }

  forget(accountId: string): void {
    delete this.data.accounts[accountId];
    delete this.data.cooldowns[accountId];
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
    void writeJson(file(), this.data).catch(() => {});
  }
}

export const usageStore = new UsageStore();

function maxReset(windows: UsageWindow[]): number | undefined {
  const r = windows.map((w) => w.resetsAt ?? 0).filter(Boolean);
  return r.length ? Math.max(...r) : undefined;
}

/** Remaining headroom (0–100): the tightest window decides. */
export function headroom(snap: UsageSnapshot | undefined, now = Date.now()): number {
  if (!snap) return 50; // unknown: rank below accounts known to be fresh, above near-exhausted ones
  const live = snap.windows.filter((w) => !w.resetsAt || w.resetsAt > now);
  if (!live.length) return 100;
  return Math.min(...live.map((w) => 100 - w.usedPct));
}

export function windowLabel(mins: number): string {
  if (Math.abs(mins - 300) <= 10) return '5h';
  if (Math.abs(mins - 10080) <= 60) return 'weekly';
  if (Math.abs(mins - 43200) <= 1440) return '30-day';
  if (mins % 1440 === 0) return `${mins / 1440}-day`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}
