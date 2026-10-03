import {adapters} from '../providers/index.js';
import {parseRef, type ModelRef} from '../providers/types.js';
import {catalog} from '../router/catalog.js';
import {defaultRef} from '../router/index.js';
import type {Config} from '../store/config.js';
import type {Engine} from './engine.js';
import {estimateTokens, renderMessages} from './transcript.js';
import type {Subagent} from '../agents/manager.js';
import {subagentConversation} from './context.js';

const CONTEXT_BUDGET_TOKENS = 24_000;

const SYSTEM = `You answer a quick side question ("by the way") about an ongoing conversation between the user and an AI coding assistant.
The assistant may be in the middle of working; you are NOT that assistant and must not continue its work.
Answer the question directly and briefly from the conversation below. If the conversation doesn't contain the answer, say so.`;

const FORK_PREFIX = `<side_question>
The user asks a quick side question while you keep working on the main task in another branch.
Answer it briefly and directly. Do not continue, redo or change the main task, and don't modify files
or run commands (only read-only tools are available here).
</side_question>

`;

export type BtwEvent = {type: 'text'; delta: string} | {type: 'mode'; mode: 'fork' | 'context'; model?: string};

/**
 * `/btw`: fork the agent's live session (full history, tool results included) and stream the
 * answer while the main turn keeps running. Falls back to a context-only one-shot when there is no
 * native session to fork yet, or the fork fails before answering. Never touches the transcript.
 */
export async function* btw(engine: Engine, cfg: Config, question: string): AsyncGenerator<BtwEvent> {
  let produced = false;
  try {
    const model = engine.current ? (catalog.get(engine.current.ref)?.label ?? engine.current.ref.model) : undefined;
    const events = engine.fork(FORK_PREFIX + question);
    for await (const ev of events) {
      if (!produced && ev.type === 'text') {
        produced = true;
        yield {type: 'mode', mode: 'fork', model};
      }
      if (ev.type === 'text') yield ev;
      else if (ev.type === 'error') throw new Error(ev.message);
    }
    if (produced) return;
  } catch (err) {
    if (produced) throw err;
  }
  const {answer, model} = await askBtw(engine, cfg, question);
  yield {type: 'mode', mode: 'context', model};
  yield {type: 'text', delta: answer};
}

/**
 * Fallback: a one-shot answer from the current chat model using the conversation text as context.
 * No tools.
 */
export async function askBtw(engine: Engine, cfg: Config, question: string): Promise<{answer: string; model: string}> {
  const fixed = cfg.chatModel && cfg.chatModel !== 'auto' ? parseRef(cfg.chatModel) : undefined;
  const ref: ModelRef | undefined = engine.current?.ref ?? fixed ?? defaultRef(cfg);
  if (!ref) throw new Error('no model available');
  const account = catalog.healthyAccounts(ref, cfg.maxUsedPct)[0];
  if (!account) throw new Error(`no healthy account for ${ref.model}`);

  const t = engine.transcript;
  // Newest messages that fit the budget, plus the compaction summary for anything older.
  const picked = [];
  let used = 0;
  for (let i = t.messages.length - 1; i >= (t.summary?.coversUpTo ?? 0); i--) {
    const cost = estimateTokens(t.messages[i]!.text) + 4;
    if (used + cost > CONTEXT_BUDGET_TOKENS) break;
    used += cost;
    picked.unshift(t.messages[i]!);
  }
  const working = engine.isBusy ? '\n\n(The assistant is still working on the last user message.)' : '';
  const prompt = [
    t.summary ? `<summary_of_earlier_conversation>\n${t.summary.text}\n</summary_of_earlier_conversation>` : '',
    `<conversation>\n${renderMessages(picked) || '(empty)'}${working}\n</conversation>`,
    `Side question: ${question}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const answer = await adapters[ref.provider].oneShot({account, model: ref.model, system: SYSTEM, prompt, timeoutMs: 120_000});
  return {answer: answer.trim(), model: catalog.get(ref)?.label ?? ref.model};
}

/** /btw while viewing a subagent: answered from that subagent's conversation, on its model. */
export async function askBtwSubagent(agent: Subagent, cfg: Config, question: string): Promise<{answer: string; model: string}> {
  const ref: ModelRef | undefined = agent.ref ?? defaultRef(cfg);
  if (!ref) throw new Error('no model available');
  const account = (agent.accountId && catalog.healthyAccounts(ref, cfg.maxUsedPct).find((a) => a.id === agent.accountId)) || catalog.healthyAccounts(ref, cfg.maxUsedPct)[0];
  if (!account) throw new Error(`no healthy account for ${ref.model}`);
  const conv = subagentConversation(agent);
  const budget = CONTEXT_BUDGET_TOKENS * 4; // characters
  const text = `${conv.messages}\n\n[tool calls]\n${conv.calls}`;
  const clipped = text.length > budget ? `[… earlier part omitted]\n${text.slice(-budget)}` : text;
  const working = agent.status === 'running' || agent.status === 'starting' ? '\n\n(The subagent is still working.)' : '';
  const prompt = `<conversation subagent="${agent.name}">\n${clipped}${working}\n</conversation>\n\nSide question: ${question}`;
  const answer = await adapters[ref.provider].oneShot({account, model: ref.model, system: SYSTEM, prompt, timeoutMs: 120_000});
  return {answer: answer.trim(), model: catalog.get(ref)?.label ?? ref.model};
}
