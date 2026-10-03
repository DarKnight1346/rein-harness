import type {ChatErrorKind, UsageSnapshot, UsageWindow} from '../types.js';

/** `rate_limit_info.unifiedWindows` keys → window length in minutes. */
function windowMinutes(key: string): number | undefined {
  if (key === 'five_hour') return 300;
  if (key.startsWith('seven_day')) return 10080;
  const m = /^(\d+)_(hour|day)/.exec(key);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === 'hour' ? 60 : 1440);
}

/**
 * `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":
 *   {"five_hour":{"utilization":0.01,"resetsAt":1791007200},"seven_day":{…}}}}`
 * utilization is 0–1, resetsAt unix seconds. Emitted once per process (first request).
 */
export function parseRateLimitEvent(ev: any, now = Date.now()): UsageSnapshot | undefined {
  const info = ev?.rate_limit_info;
  if (!info) return undefined;
  const windows: UsageWindow[] = [];
  for (const [key, w] of Object.entries<any>(info.unifiedWindows ?? {})) {
    const mins = windowMinutes(key);
    if (!mins || typeof w?.utilization !== 'number') continue;
    // Several weekly sub-limits (e.g. per-model) may exist; keep the tightest per length.
    const existing = windows.find((x) => x.windowMins === mins);
    const win = {usedPct: Math.round(w.utilization * 1000) / 10, resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined, windowMins: mins};
    if (!existing) windows.push(win);
    else if (win.usedPct > existing.usedPct) Object.assign(existing, win);
  }
  if (!windows.length && info.rateLimitType && typeof info.utilization === 'number') {
    const mins = windowMinutes(info.rateLimitType);
    if (mins) windows.push({usedPct: info.utilization * 100, resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined, windowMins: mins});
  }
  const limited = typeof info.status === 'string' && !info.status.startsWith('allowed');
  if (limited && !windows.some((w) => w.usedPct >= 100) && info.resetsAt) {
    // Rejected without a full window in the payload: record the reset as an exhausted window.
    const mins = windowMinutes(info.rateLimitType ?? '') ?? 300;
    windows.push({usedPct: 100, resetsAt: info.resetsAt * 1000, windowMins: mins});
  }
  windows.sort((a, b) => a.windowMins - b.windowMins);
  return {windows, at: now, source: 'live', limited};
}

export function classifyError(text: string): ChatErrorKind {
  if (/hit your .*limit|usage limit|rate.?limit|limit reached|resets? /i.test(text)) return 'limit';
  if (/overloaded|529|capacity/i.test(text)) return 'overloaded';
  if (/prompt is too long|context (window|length)|too many tokens/i.test(text)) return 'context';
  if (/log ?in|logged out|auth|credential|401|403|oauth/i.test(text)) return 'auth';
  return 'other';
}

/**
 * Parse "resets 3:45pm" / "resets 11am" / "resets Oct 5, 9am" style hints into the next matching
 * local time (epoch ms). Defensive: returns undefined when nothing parses.
 */
export function parseResetTime(text: string, now = new Date()): number | undefined {
  const m = /resets?\s+(?:at\s+)?(?:([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return undefined;
  let hour = Number(m[3]) % 12;
  if (m[5]!.toLowerCase() === 'pm') hour += 12;
  const minute = m[4] ? Number(m[4]) : 0;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hour, minute);
  if (m[1] && m[2]) {
    const month = new Date(`${m[1]} 1, 2000`).getMonth();
    if (!Number.isNaN(month)) {
      d.setMonth(month, Number(m[2]));
      if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
      return d.getTime();
    }
  }
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
