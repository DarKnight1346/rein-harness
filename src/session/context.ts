import type {ModelRef} from '../providers/types.js';
import {parseRef} from '../providers/types.js';
import {catalog} from '../router/catalog.js';
import {defaultRef} from '../router/index.js';
import type {Config} from '../store/config.js';
import type {Engine} from './engine.js';
import {systemPrompt} from './prompt.js';
import {estimateTokens, renderMessages} from './transcript.js';
import type {ToolSpec} from '../tools/host.js';

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
  const recent = t.messages.slice(from);
  const calls = recent.flatMap((m) => m.tools ?? []).map((x) => `${x.label} ${x.summary}\n${x.result}`).join('\n');
  const categories: ContextCategory[] = [
    {key: 'system', label: 'System prompt', tokens: estimateTokens(await systemPrompt({tools: true}))},
    {key: 'tools', label: `Tool definitions (${toolSpecs.length})`, tokens: toolSpecs.length ? estimateTokens(JSON.stringify(toolSpecs)) : 0},
    {key: 'summary', label: 'Summary', tokens: t.summary ? estimateTokens(t.summary.text) : 0},
    {key: 'messages', label: 'Messages', tokens: estimateTokens(renderMessages(recent))},
    {key: 'calls', label: 'Tool calls & results', tokens: calls ? estimateTokens(calls) : 0},
  ];
  const last = engine.lastUsage;
  const measured = last && model && last.ref.provider === model.provider && last.ref.model === model.model ? last.input : undefined;
  const estimated = categories.reduce((n, c) => n + c.tokens, 0);
  if (measured !== undefined && measured > estimated) categories.push({key: 'other', label: 'Other (provider overhead, full tool output)', tokens: measured - estimated});
  const used = Math.max(estimated, measured ?? 0);
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
  };
}
