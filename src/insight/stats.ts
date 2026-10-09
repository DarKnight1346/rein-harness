import path from 'node:path';
import {isTestCommand} from '../build/flaky.js';
import {formatUsd} from '../providers/prices.js';
import {listTranscripts, loadTranscript, type Transcript} from '../session/transcript.js';

/**
 * Local session analytics (/stats): from the conversations saved on this machine, how requests go —
 * how long they take, how many tool calls, failures and retries, whether the tests passed at the
 * end, and what they cost — per model. A request is one message from you and everything the agent
 * did until your next one. Nothing leaves the machine.
 */
export type RequestStat = {conversation: string; at: number; ms: number; tools: number; failed: number; retries: number; tests?: 'passed' | 'failed'; interrupted: boolean; model?: string; usd?: number};

/** The requests in a conversation. Cost is the conversation's, shared evenly (per-message cost isn't saved). */
export function requestsOf(t: Transcript): RequestStat[] {
  const out: RequestStat[] = [];
  const msgs = t.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role !== 'user' || m.synthetic || /^<(code_check|stop_hook)>/.test(m.text)) continue;
    let j = i + 1;
    while (j < msgs.length && !(msgs[j]!.role === 'user' && !msgs[j]!.synthetic && !/^<(code_check|stop_hook)>/.test(msgs[j]!.text))) j++;
    const replies = msgs.slice(i + 1, j).filter((x) => x.role === 'assistant');
    const calls = replies.flatMap((r) => r.tools ?? []);
    let retries = 0;
    calls.forEach((c, k) => {
      if (!c.ok && calls.slice(k + 1).some((d) => d.label === c.label && d.summary === c.summary)) retries++;
    });
    const testRuns = calls.filter((c) => c.label === 'Shell' && isTestCommand(c.summary.replace(/^[$&]\s*/, '')));
    const last = replies[replies.length - 1];
    const model = [...replies].reverse().find((r) => r.model)?.model;
    out.push({
      conversation: t.id,
      at: m.at,
      ms: last ? Math.max(0, last.at - m.at) : 0,
      tools: calls.length,
      failed: calls.filter((c) => !c.ok).length,
      retries,
      ...(testRuns.length ? {tests: testRuns[testRuns.length - 1]!.ok ? ('passed' as const) : ('failed' as const)} : {}),
      interrupted: replies.some((r) => r.interrupted || r.cutOff) || !replies.length,
      ...(model ? {model: `${model.provider}:${model.model}`} : {}),
    });
    i = j - 1;
  }
  const usd = t.tokens?.usd;
  if (usd !== undefined && out.length) for (const r of out) r.usd = usd / out.length;
  return out;
}

export type Stats = {conversations: number; requests: RequestStat[]; since: number; scope: string};

export async function collectStats(opts: {cwd?: string; days?: number} = {}): Promise<Stats> {
  const days = opts.days ?? 30;
  const since = Date.now() - days * 86_400_000;
  const infos = (await listTranscripts(opts.cwd ? {cwd: opts.cwd} : {})).filter((s) => s.updatedAt >= since);
  const requests: RequestStat[] = [];
  let conversations = 0;
  for (const info of infos) {
    const t = await loadTranscript(info.id).catch(() => undefined);
    if (!t) continue;
    const rs = requestsOf(t).filter((r) => r.at >= since);
    if (rs.length) conversations++;
    requests.push(...rs);
  }
  return {conversations, requests, since, scope: opts.cwd ? path.basename(opts.cwd) : 'all projects'};
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

function summary(rs: RequestStat[]): {line: string; tested: number; passed: number} {
  const tested = rs.filter((r) => r.tests).length;
  const passed = rs.filter((r) => r.tests === 'passed').length;
  const usd = rs.filter((r) => r.usd !== undefined);
  const cost = usd.length ? `, ${formatUsd(usd.reduce((n, r) => n + r.usd!, 0) / usd.length)} a request` : '';
  return {line: `${rs.length} request${rs.length === 1 ? '' : 's'}, median ${dur(median(rs.map((r) => r.ms)))}, ${(rs.reduce((n, r) => n + r.tools, 0) / (rs.length || 1)).toFixed(1)} tool calls each, tests passed at the end ${pct(passed, tested)} (of ${tested} tested)${cost}`, tested, passed};
}

export function formatStats(s: Stats, days: number): string {
  const rs = s.requests;
  if (!rs.length) return `No requests in the last ${days} days (${s.scope}).`;
  const calls = rs.reduce((n, r) => n + r.tools, 0);
  const failed = rs.reduce((n, r) => n + r.failed, 0);
  const retries = rs.reduce((n, r) => n + r.retries, 0);
  const usd = rs.filter((r) => r.usd !== undefined);
  const all = summary(rs);
  const byModel = new Map<string, RequestStat[]>();
  for (const r of rs) byModel.set(r.model ?? 'unknown', [...(byModel.get(r.model ?? 'unknown') ?? []), r]);
  return [
    `Last ${days} days, ${s.scope}: ${s.conversations} conversation${s.conversations === 1 ? '' : 's'}, ${rs.length} request${rs.length === 1 ? '' : 's'}`,
    `  time per request   median ${dur(median(rs.map((r) => r.ms)))} · longest ${dur(Math.max(...rs.map((r) => r.ms)))}`,
    `  tool calls         ${calls} (${(calls / rs.length).toFixed(1)} a request) · ${pct(failed, calls)} failed · ${retries} retr${retries === 1 ? 'y' : 'ies'} of a failed call`,
    `  tests at the end   passed in ${all.passed} of ${all.tested} requests that ran tests (${pct(all.passed, all.tested)})`,
    `  interrupted        ${rs.filter((r) => r.interrupted).length} request${rs.filter((r) => r.interrupted).length === 1 ? '' : 's'}`,
    ...(usd.length ? [`  cost               ${formatUsd(usd.reduce((n, r) => n + r.usd!, 0))} at API list prices (${formatUsd(usd.reduce((n, r) => n + r.usd!, 0) / usd.length)} a request)`] : []),
    'By model:',
    ...[...byModel].sort((a, b) => b[1].length - a[1].length).map(([m, list]) => `  ${m.padEnd(28)} ${summary(list).line}`),
  ].join('\n');
}
