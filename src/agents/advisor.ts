import {adapters} from '../providers/index.js';
import {parseRef} from '../providers/types.js';
import {catalog} from '../router/catalog.js';
import type {Engine} from '../session/engine.js';
import {estimateTokens, renderMessages, summaryForModel} from '../session/transcript.js';
import type {Config} from '../store/config.js';
import {ToolError} from '../tools/fs.js';
import type {ToolDef} from '../tools/registry.js';
import type {SubagentManager} from './manager.js';

const CONTEXT_BUDGET_TOKENS = 40_000;

const ADVISOR_SYSTEM = `You are the advisor: a stronger model consulted by an AI coding agent while it works for a user.
You see what the agent has done so far and its question. Give direct, specific guidance — the best next
step, flaws or risks in its approach, what it may have missed. Be concise and concrete; no preamble.
You can't use tools; reason from what you're given and say what the agent should check if unsure.`;

/** The configured advisor (never auto), if signed in. */
export function advisorRef(cfg: Config) {
  if (!cfg.advisorModel || cfg.advisorModel === 'off') return undefined;
  const ref = parseRef(cfg.advisorModel);
  return ref && catalog.get(ref) ? ref : undefined;
}

/** Newest messages that fit the budget, after the compaction summary. */
function mainContext(engine: Engine): string {
  const t = engine.transcript;
  const picked = [];
  let used = 0;
  for (let i = t.messages.length - 1; i >= (t.summary?.coversUpTo ?? 0); i--) {
    const m = t.messages[i]!;
    const tools = (m.tools ?? []).map((x) => `[${x.label}(${x.summary}) ${x.ok ? 'ok' : 'failed'}: ${x.result.split('\n')[0]?.slice(0, 200) ?? ''}]`).join('\n');
    const cost = estimateTokens(m.text + tools) + 4;
    if (used + cost > CONTEXT_BUDGET_TOKENS) break;
    used += cost;
    picked.unshift({...m, text: tools ? `${tools}\n${m.text}` : m.text});
  }
  return [t.summary ? `<summary>\n${summaryForModel(t.summary)}\n</summary>` : '', renderMessages(picked)].filter(Boolean).join('\n\n');
}

/**
 * `advisor` tool (main agent and subagents) — only listed when an advisor model is configured in
 * /model. One call to the expensive model with the caller's context + question.
 */
export function advisorTool(deps: {config(): Config; engine(): Engine; agents: SubagentManager}): ToolDef {
  return {
    name: 'advisor',
    label: 'Advisor',
    description: 'Ask the advisor model for guidance.',
    enabled: () => !!advisorRef(deps.config()),
    describe: () => {
      const ref = advisorRef(deps.config());
      const label = ref ? (catalog.get(ref)?.label ?? ref.model) : 'the advisor';
      return (
        `Ask the advisor (${label}) — a more capable and much more expensive model — for guidance. ` +
        'Use it sparingly, at key moments: before committing to a non-trivial approach, when stuck or going in circles, ' +
        'or to sanity-check a plan or a tricky change. It sees the conversation so far (or your subagent task and work) plus your question; ' +
        'it cannot run tools. Ask a specific question and include anything it needs that is not in the conversation.'
      );
    },
    inputSchema: {
      type: 'object',
      properties: {
        question: {type: 'string', description: 'What you want advice on — be specific'},
        context: {type: 'string', description: 'Extra details the advisor needs (code, errors, options considered)'},
      },
      required: ['question'],
    },
    mutating: false,
    summarize: (a) => String(a?.question ?? '').replace(/\s+/g, ' ').slice(0, 80),
    async run(ctx, args) {
      const cfg = deps.config();
      const ref = advisorRef(cfg);
      if (!ref) throw new ToolError('no advisor is configured (the user can set one in /model → Advisor)');
      if (typeof args?.question !== 'string' || !args.question.trim()) throw new ToolError('question is required');
      const account = catalog.healthyAccounts(ref, cfg.maxUsedPct)[0];
      if (!account) throw new ToolError(`the advisor (${ref.model}) has no healthy account right now`);
      const sub = ctx.origin ? deps.agents.get(ctx.origin.agentId) : undefined;
      const work = sub
        ? `<subagent_task>\n${sub.task}\n</subagent_task>\n\n<subagent_work_so_far>\n${sub.events
            .map((e) => (e.kind === 'text' ? e.text : e.kind === 'tool' ? `[${e.label}(${e.summary})${e.ok === false ? ' failed' : ''}]` : e.kind === 'user' ? `User: ${e.text}` : ''))
            .filter(Boolean)
            .join('\n')
            .slice(-CONTEXT_BUDGET_TOKENS * 4)}\n</subagent_work_so_far>`
        : `<conversation>\n${mainContext(deps.engine()) || '(empty)'}\n</conversation>`;
      const prompt = `${work}\n\n${args.context ? `<details_from_agent>\n${args.context}\n</details_from_agent>\n\n` : ''}Question from the ${sub ? `subagent "${sub.name}"` : 'agent'}: ${args.question}`;
      const advice = await adapters[ref.provider].oneShot({account, model: ref.model, system: ADVISOR_SYSTEM, prompt, timeoutMs: 300_000});
      return {ok: true, text: `Advice from ${catalog.get(ref)?.label ?? ref.model}:\n${advice.trim()}`};
    },
  };
}
