import type {ModelRef} from '../providers/types.js';
import {parseRef} from '../providers/types.js';
import {catalog} from '../router/catalog.js';
import {defaultRef} from '../router/index.js';
import type {Config} from '../store/config.js';
import type {Engine} from './engine.js';
import {agentsFiles, systemPrompt} from './prompt.js';
import {estimateTokens, renderMessages, resultTokens, summaryForModel} from './transcript.js';
import type {ToolSpec} from '../tools/host.js';
import {SUBAGENT_PROMPT, type Subagent} from '../agents/manager.js';

export type ContextCategory = {key: 'system' | 'tools' | 'summary' | 'messages' | 'calls' | 'other'; label: string; tokens: number};

export type ContextReport = {
  model: ModelRef | undefined;
  modelLabel: string;
  window: number;
  categories: ContextCategory[];
  used: number;
  /** Provider-reported input tokens of the last request on this model, if any. */
  measured?: number;
  messageCount: number;
  summarizedCount: number;
  autoCompactAt: number;
  /** The biggest single items in context (instruction files, tool results, the summary), largest first. */
  largest?: {what: string; tokens: number}[];
};

/**
 * What the next request would carry: Rein's system prompt, the tool definitions, the compaction
 * summary (if any), the messages after it and their tool calls/results. Token counts are estimates
 * (~4 chars/token); when the provider measured the last request, whatever the estimates miss
 * (provider/CLI overhead, tool output Rein only keeps an excerpt of) shows as "Other".
 */
export async function contextReport(engine: Engine, cfg: Config, toolSpecs: ToolSpec[] = []): Promise<ContextReport> {
  const t = engine.transcript;
  const model = engine.current?.ref ?? (cfg.chatModel && cfg.chatModel !== 'auto' ? parseRef(cfg.chatModel) : undefined) ?? defaultRef(cfg);
  const info = model ? catalog.get(model) : undefined;
  const window = info?.contextWindow ?? 200_000;
  const from = t.summary?.coversUpTo ?? 0;
  // Plus the turn in progress (its reply and tool calls are saved to the transcript when it ends).
  const live = engine.inFlight;
  const recent = [...t.messages.slice(from), ...(live ? [{role: 'assistant' as const, text: live.reply, at: Date.now(), tools: live.tools}] : [])];
  const calls = recent.flatMap((m) => m.tools ?? []).map((x) => `${x.label} ${x.summary}\n${x.result}`).join('\n');
  const categories: ContextCategory[] = [
    {key: 'system', label: 'System prompt', tokens: estimateTokens(await systemPrompt({tools: true}))},
    {key: 'tools', label: `Tool definitions (${toolSpecs.length})`, tokens: toolSpecs.length ? estimateTokens(JSON.stringify(toolSpecs)) : 0},
    {key: 'summary', label: 'Summary', tokens: t.summary ? estimateTokens(summaryForModel(t.summary)) : 0},
    {key: 'messages', label: 'Messages', tokens: estimateTokens(renderMessages(recent))},
    {key: 'calls', label: 'Tool calls & results', tokens: calls ? estimateTokens(calls) : 0},
  ];
  const last = engine.lastUsage;
  const measured = last && model && last.ref.provider === model.provider && last.ref.model === model.model ? last.input : undefined;
  const estimated = categories.reduce((n, c) => n + c.tokens, 0);
  if (measured !== undefined && measured > estimated) categories.push({key: 'other', label: 'Other (provider overhead, full tool output)', tokens: measured - estimated});
  const used = Math.max(estimated, measured ?? 0);
  // What's taking the space, so you know what to drop or compact: each instruction file, each tool result.
  const items = [
    ...(await agentsFiles()).map((f) => ({what: `instructions ${f.path}`, tokens: estimateTokens(f.text)})),
    ...(t.summary ? [{what: 'compaction summary', tokens: estimateTokens(summaryForModel(t.summary))}] : []),
    ...recent.flatMap((m) => m.tools ?? []).map((x) => ({what: `${x.label}(${x.summary.slice(0, 60)})`, tokens: resultTokens(x)})),
  ];
  return {
    model,
    modelLabel: info?.label ?? model?.model ?? 'no model',
    window,
    categories,
    used,
    measured,
    messageCount: t.messages.length,
    summarizedCount: from,
    autoCompactAt: cfg.autoCompactPct ? Math.round(window * (cfg.autoCompactPct / 100)) : 0,
    largest: items.filter((i) => i.tokens >= 200).sort((a, b) => b.tokens - a.tokens).slice(0, 8),
  };
}

/** The conversation a subagent has had, as text (task, its replies, your messages, tool calls). */
export function subagentConversation(agent: Subagent): {messages: string; calls: string} {
  const messages: string[] = [`[task]\n${agent.task}`];
  const calls: string[] = [];
  for (const e of agent.events) {
    if (e.kind === 'text') messages.push(`[${agent.name}]\n${e.text}`);
    else if (e.kind === 'user') messages.push(`[user]\n${e.text}`);
    else if (e.kind === 'tool') calls.push(`${e.label} ${e.summary}\n${e.result ?? ''}`);
  }
  return {messages: messages.join('\n\n'), calls: calls.join('\n')};
}

/**
 * /context while viewing a subagent: its own context. A fork also carries the parent's history up
 * to the fork (counted under "Inherited" from the measured size).
 */
export async function subagentContextReport(agent: Subagent, cfg: Config, toolSpecs: ToolSpec[] = []): Promise<ContextReport> {
  const model = agent.ref;
  const info = model ? catalog.get(model) : undefined;
  const window = info?.contextWindow ?? 200_000;
  const conv = subagentConversation(agent);
  const categories: ContextCategory[] = [
    {key: 'system', label: 'System prompt', tokens: estimateTokens(`${await systemPrompt({tools: true})}\n\n${SUBAGENT_PROMPT(agent.name)}`)},
    {key: 'tools', label: `Tool definitions (${toolSpecs.length})`, tokens: toolSpecs.length ? estimateTokens(JSON.stringify(toolSpecs)) : 0},
    {key: 'messages', label: 'Task & messages', tokens: estimateTokens(conv.messages)},
    {key: 'calls', label: 'Tool calls & results', tokens: conv.calls ? estimateTokens(conv.calls) : 0},
  ];
  const measured = agent.lastInput;
  const estimated = categories.reduce((n, c) => n + c.tokens, 0);
  if (measured !== undefined && measured > estimated)
    categories.push({key: 'other', label: agent.mode === 'fork' ? 'Inherited from the parent + provider overhead' : 'Other (provider overhead, full tool output)', tokens: measured - estimated});
  const turns = agent.events.filter((e) => e.kind === 'text' || e.kind === 'user').length + 1;
  return {
    model,
    modelLabel: agent.modelLabel ?? info?.label ?? model?.model ?? 'resolving…',
    window,
    categories,
    used: Math.max(estimated, measured ?? 0),
    measured,
    messageCount: turns,
    summarizedCount: 0,
    autoCompactAt: 0,
  };
}
