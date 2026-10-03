import {describe, expect, it} from 'vitest';
import {classifyError, parseRateLimitEvent, parseResetTime} from '../src/providers/claude/stream.js';
import {claudeArgs} from '../src/providers/claude/session.js';
import {classifyCodexError, snapshotFromRateLimits} from '../src/providers/codex/adapter.js';
import {appServerArgs, codexTier, stripTools} from '../src/providers/codex/catalog.js';
import {headroom, windowLabel} from '../src/store/usage.js';
import {buildCarry, newTranscript} from '../src/session/transcript.js';

describe('claude stream parsing', () => {
  it('parses the rate_limit_event captured in M0', () => {
    const ev = {type: 'rate_limit_event', rate_limit_info: {status: 'allowed', resetsAt: 1791007200, rateLimitType: 'five_hour', unifiedWindows: {five_hour: {utilization: 0.01, resetsAt: 1791007200}, seven_day: {utilization: 0, resetsAt: 1791302400}}}};
    expect(parseRateLimitEvent(ev, 5)).toEqual({
      windows: [{usedPct: 1, resetsAt: 1791007200000, windowMins: 300}, {usedPct: 0, resetsAt: 1791302400000, windowMins: 10080}],
      at: 5, source: 'live', limited: false,
    });
  });
  it('marks rejected status as limited with an exhausted window', () => {
    const snap = parseRateLimitEvent({rate_limit_info: {status: 'rejected', resetsAt: 100, rateLimitType: 'five_hour'}})!;
    expect(snap.limited).toBe(true);
    expect(snap.windows).toEqual([{usedPct: 100, resetsAt: 100_000, windowMins: 300}]);
  });
  it('classifies errors', () => {
    expect(classifyError("You've hit your session limit · resets 3:45pm")).toBe('limit');
    expect(classifyError('API Error: 529 overloaded')).toBe('overloaded');
    expect(classifyError('Prompt is too long')).toBe('context');
    expect(classifyError('Please run /login · OAuth token expired')).toBe('auth');
    expect(classifyError('boom')).toBe('other');
  });
  it('parses reset times to the next occurrence', () => {
    const now = new Date(2026, 9, 2, 14, 0);
    expect(new Date(parseResetTime('resets 3:45pm', now)!).getHours()).toBe(15);
    const tomorrow = new Date(parseResetTime('resets 9am', now)!);
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([3, 9]);
    expect(new Date(parseResetTime('resets Oct 5, 9am', now)!).getDate()).toBe(5);
    expect(parseResetTime('no time here', now)).toBeUndefined();
  });
  it('never passes --bare and always strips tools/MCP', () => {
    const args = claudeArgs({model: 'haiku', systemPrompt: 'x', persist: false});
    expect(args).not.toContain('--bare');
    expect(args.join(' ')).toContain('--tools  --strict-mcp-config --mcp-config {"mcpServers":{}}');
    expect(args).toContain('--no-session-persistence');
    expect(claudeArgs({model: 'haiku', systemPrompt: 'x', persist: true, resumeId: 'abc'})).toEqual(expect.arrayContaining(['--resume', 'abc']));
  });
});

describe('codex parsing', () => {
  it('maps rate-limit windows by duration (free plan: one 30-day window)', () => {
    const snap = snapshotFromRateLimits({primary: {usedPercent: 3, windowDurationMins: 43200, resetsAt: 10}, secondary: null}, true, 1)!;
    expect(snap.windows).toEqual([{usedPct: 3, resetsAt: 10_000, windowMins: 43200}]);
    expect(windowLabel(43200)).toBe('30-day');
    const paid = snapshotFromRateLimits({primary: {usedPercent: 50, windowDurationMins: 10080}, secondary: {usedPercent: 99, windowDurationMins: 300}})!;
    expect(paid.windows.map((w) => windowLabel(w.windowMins))).toEqual(['5h', 'weekly']);
    expect(headroom(paid)).toBe(1);
  });
  it('classifies codexErrorInfo', () => {
    expect(classifyCodexError({codexErrorInfo: 'usageLimitExceeded'})).toBe('limit');
    expect(classifyCodexError({codexErrorInfo: 'contextWindowExceeded'})).toBe('context');
    expect(classifyCodexError({codexErrorInfo: {httpConnectionFailed: {httpStatusCode: 401}}})).toBe('auth');
    expect(classifyCodexError({codexErrorInfo: 'other', message: 'x'})).toBe('other');
  });
  it('strips every tool-bearing catalog field', () => {
    const out = stripTools({models: [{slug: 'm', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform', shell_type: 'unified_exec', multi_agent_version: 'v2'}]});
    expect(out.models[0]).toMatchObject({slug: 'm', tool_mode: null, apply_patch_tool_type: null, shell_type: 'disabled', multi_agent_version: null});
    expect(appServerArgs('/c.json')).toEqual(expect.arrayContaining(['--disable', 'shell_tool', '-c', 'model_catalog_json="/c.json"']));
  });
  it('ranks cost tiers from descriptions', () => {
    expect(codexTier('gpt-6-luna', 'Fast and affordable model for easier tasks.')).toBe(1);
    expect(codexTier('gpt-5.6-terra', 'Older balanced model for straightforward work.')).toBe(3);
    expect(codexTier('gpt-5.5', 'Legacy coding model.')).toBe(4);
  });
});

describe('context carry', () => {
  it('carries only what the native session has not seen, preferring the summary', () => {
    const t = newTranscript();
    t.messages.push({role: 'user', text: 'a', at: 0}, {role: 'assistant', text: 'b', at: 0}, {role: 'user', text: 'c', at: 0});
    expect(buildCarry(t, 2, 2, 1000).text).toBe('');
    const all = buildCarry(t, 0, 2, 1000).text;
    expect(all).toContain('User: a');
    expect(all).toContain('Assistant: b');
    t.summary = {text: 'SUM', coversUpTo: 2};
    const withSummary = buildCarry(t, 0, 2, 1000).text;
    expect(withSummary).toContain('SUM');
    expect(withSummary).not.toContain('User: a');
  });
});
