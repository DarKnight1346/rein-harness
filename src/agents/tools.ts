import {parseRef, refKey} from '../providers/types.js';
import {catalog, toRef} from '../router/catalog.js';
import {activeExperiments, type Config} from '../store/config.js';
import {ToolError} from '../tools/fs.js';
import type {ToolDef} from '../tools/registry.js';
import {definitionModel, loadAgentDefinitions, type AgentDefinition} from './definitions.js';
import {subagentStatusText, type Subagent, type SubagentManager} from './manager.js';

const COST = ['', 'very low', 'low', 'medium', 'high', 'very high', 'highest'];

/** Models the user is signed into right now (healthy accounts only). */
function availableModels(cfg: Config) {
  return catalog.available(cfg.maxUsedPct).map((m) => ({value: refKey(toRef(m)), line: `- ${refKey(toRef(m))}: ${m.label} — ${m.description ?? 'general model'} (cost: ${COST[Math.min(6, m.tier)]})`}));
}

/** The user's subagent model from /model (undefined = auto, or that model isn't signed in). */
function userModel(cfg: Config): {value: string; label: string} | undefined {
  if (!cfg.subagentModel || cfg.subagentModel === 'auto') return undefined;
  const ref = parseRef(cfg.subagentModel);
  const m = ref ? catalog.get(ref) : undefined;
  return ref && m && catalog.healthyAccounts(ref, cfg.maxUsedPct).length ? {value: refKey(ref), label: m.label} : undefined;
}

/** "Your model first" with a model set: the agent's choice can't matter, so it isn't offered. */
const forced = (cfg: Config) => (cfg.subagentPriority ?? 'user') === 'user' ? userModel(cfg) : undefined;

/**
 * Model for a new-mode subagent, in the user's priority order:
 * 'user'  → your model → the agent's choice → auto
 * 'agent' → the agent's choice → your model → auto
 */
export function subagentModelFor(cfg: Config, requested: unknown): string {
  const asked = typeof requested === 'string' && requested && requested !== 'auto' ? requested : undefined;
  const mine = userModel(cfg)?.value;
  const order = (cfg.subagentPriority ?? 'user') === 'agent' ? [asked, mine] : [mine, asked];
  return order.find(Boolean) ?? 'auto';
}

/** cheap-explore: the explorer's role; read-only tools, findings sized for a pricier model's context. */
const EXPLORER: AgentDefinition = {
  name: 'explore',
  description: 'Finds things in the codebase for the main agent',
  tools: ['read', 'list', 'search'],
  file: '',
  prompt: `You explore a codebase for another agent, a more expensive model that will make the change. Answer its question by reading and searching the code. Report what you found: file paths with line numbers, exact names and signatures, and short verbatim snippets of the lines that matter (never whole files). Say plainly what you looked for and didn't find. Don't propose or make changes. Be concise: your report goes into the other model's context.`,
};

/** cheap-explore: the cheapest signed-in Claude model (Haiku), else none. */
function explorerModel(cfg: Config): string | undefined {
  const m = catalog.available(cfg.maxUsedPct).filter((x) => toRef(x).provider === 'claude').sort((a, b) => a.tier - b.tier || Number(b.id === 'haiku') - Number(a.id === 'haiku'))[0]; // the current Haiku, not an old one
  return m ? refKey(toRef(m)) : undefined;
}

export function report(a: Subagent): string {
  const head = `Subagent #${a.id} "${a.name}" (${a.modelLabel ?? a.requested} · ${a.mode}) ${subagentStatusText(a)}${a.rounds > 1 ? ` · ${a.rounds - 1} continuation round(s) after completion checks` : ''}`;
  if (a.status === 'failed') return `${head}\nError: ${a.error}`;
  if (a.status === 'cancelled') return `${head}\nIt was stopped by the user.${a.output ? `\nPartial output:\n${a.output}` : ''}`;
  return `${head}\n\n${a.output || '(no report)'}`;
}

/** The main agent's `agent` and `agent_result` tools (never available to subagents). */
export function agentTools(agents: SubagentManager, config: () => Config): ToolDef[] {
  return [
    {
      name: 'agent',
      label: 'Agent',
      description: 'Spawn a subagent.',
      describe: () => {
        const cfg = config();
        const models = availableModels(cfg);
        const fixed = forced(cfg);
        const preferred = !fixed ? userModel(cfg) : undefined;
        return [
          'Delegate a task to a subagent that works autonomously with the same tools and returns a report.',
          ...(activeExperiments(cfg).includes('lean-subagents')
            ? ["- Each subagent starts its own context (instructions, tools and everything it reads), so it costs about as much as doing that work yourself, plus the report. Use one for independent work that can run in parallel, a long side investigation, or another model; not to split one focused change across files (do that yourself, batching edits)."]
            : []),
          '- mode "fork": branches your current session — it keeps the full conversation history and uses your current model/account (good for parallel work that needs context).',
          '- mode "new": a fresh session with no history on any model below — the task must be self-contained (good for independent work, or to use a cheaper/stronger model).',
          fixed
            ? `- New-mode subagents run on ${fixed.label} (set by the user in /model). Fork mode keeps your current model.`
            : preferred
              ? `- model: pick one for new mode, or leave it out to use the user's default, ${preferred.label}. "auto" lets the decision model pick. Fork mode ignores model.`
              : `- model "auto" lets the decision model pick the best model for the task (new mode). Fork mode ignores model.`,
          '- background: true returns an id at once; otherwise this call waits and returns the report.',
          'Two ways to work with subagents — pick per task:',
          '  • Orchestrate: spawn several in the background, then collect each with agent_result {id, wait: true} (you wait while they work).',
          '  • Work alongside: spawn in the background and keep doing your own part with your tools; collect with agent_result when you need the results.',
          '  If you end your turn while background subagents are still running, each report is delivered to you as a message when it finishes.',
          `- A decision model checks each subagent's work and makes it continue if it isn't complete. At most ${cfg.subagentLimit} subagents run at once.`,
          ...(fixed ? [] : ['Models available now:', ...models.map((m) => m.line)]),
          ...(() => {
            const defs = loadAgentDefinitions();
            return defs.length
              ? ['Specialized subagents (agent_type; always a new session, with their own role, tools and model):', ...defs.map((d) => `- ${d.name}: ${d.description}`)]
              : [];
          })(),
        ].join('\n');
      },
      inputSchema: {},
      schema: () => {
        const cfg = config();
        const models = availableModels(cfg).map((m) => m.value);
        return {
          type: 'object',
          properties: {
            task: {type: 'string', description: 'Complete, self-contained instructions for the subagent (what to do, where, what to report)'},
            mode: {type: 'string', enum: ['new', 'fork'], description: 'fork = keep this conversation history; new = fresh session'},
            // A user-fixed subagent model removes the choice entirely.
            ...(forced(cfg) ? {} : {model: {type: 'string', enum: ['auto', ...models], description: 'Model for new mode ("auto" = decision model picks)'}}),
            name: {type: 'string', description: 'Short name shown to the user (e.g. "test-writer")'},
            background: {type: 'boolean', description: 'Return immediately; collect later with agent_result'},
            ...(() => {
              const defs = loadAgentDefinitions().map((d) => d.name);
              return defs.length ? {agent_type: {type: 'string', enum: defs, description: 'Run as one of the specialized subagents listed above'}} : {};
            })(),
          },
          required: ['task', 'mode'],
        };
      },
      mutating: false,
      mainOnly: true,
      summarize: (a) => `${a?.name ?? 'agent'} · ${a?.mode === 'fork' ? 'fork' : a?.model ?? 'auto'}${a?.background ? ' · background' : ''}`,
      async run(_ctx, args) {
        if (typeof args?.task !== 'string' || !args.task.trim()) throw new ToolError('task is required');
        const definition = typeof args.agent_type === 'string' ? loadAgentDefinitions().find((d) => d.name === args.agent_type) : undefined;
        if (args.agent_type && !definition) throw new ToolError(`no subagent type "${args.agent_type}"`);
        // A specialized subagent always starts fresh with its own role; its model (if set) wins.
        const mode = definition ? 'new' : args.mode === 'fork' ? 'fork' : 'new';
        // The definition's model if it's signed in (`inherit` = the main agent's), else the usual choice.
        const wanted = definition?.model === 'inherit' ? 'inherit' : definitionModel(definition?.model);
        const usable = wanted === 'inherit' || (wanted && parseRef(wanted) && catalog.get(parseRef(wanted)!));
        const model = (usable ? wanted : undefined) ?? subagentModelFor(config(), args.model);
        let spawned;
        try {
          spawned = agents.spawn({task: args.task, mode, model, name: args.name ?? definition?.name, background: !!args.background, definition});
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
        if (args.background) {
          return {ok: true, text: `Started subagent #${spawned.agent.id} "${spawned.agent.name}" (${mode}${mode === 'new' ? `, ${model}` : ''}). Collect its report with agent_result {id: ${spawned.agent.id}, wait: true}.`};
        }
        const a = await spawned.done;
        a.collected = true;
        return {ok: a.status === 'done', text: report(a)};
      },
    },
    {
      // cheap-explore: finding things across a codebase is a third of what a large task costs before its
      // first edit, every file read staying in the expensive model's context; Claude Code sends this to Haiku too.
      name: 'explore',
      label: 'Explore',
      description: 'Ask a fast, cheap model to find things in the codebase.',
      describe: () =>
        'Ask a fast, cheap model to explore the codebase and answer a question: where something is defined or used, how existing code works, which files a change touches. It reads and searches the code itself and reports file paths, line numbers, names and signatures with short verbatim snippets, so the files it read stay out of your context. Ask several questions in one call or in parallel calls. Read the exact lines yourself before you edit them.',
      inputSchema: {type: 'object', properties: {question: {type: 'string', description: 'What to find out, with any names, paths or context that help'}}, required: ['question']},
      enabled: () => activeExperiments(config()).includes('cheap-explore') && !!explorerModel(config()),
      mutating: false,
      mainOnly: true,
      summarize: (a) => String(a?.question ?? '').slice(0, 80),
      async run(_ctx, args) {
        if (typeof args?.question !== 'string' || !args.question.trim()) throw new ToolError('question is required');
        const model = explorerModel(config());
        if (!model) throw new ToolError('no cheap model is signed in for exploring');
        let spawned;
        try {
          spawned = agents.spawn({task: args.question, mode: 'new', model, name: 'explore', definition: EXPLORER});
        } catch (err) {
          throw new ToolError((err as Error).message);
        }
        const a = await spawned.done;
        a.collected = true;
        return {ok: a.status === 'done', text: a.status === 'done' ? a.output || '(no findings)' : report(a)};
      },
    },
    {
      name: 'agent_result',
      label: 'AgentResult',
      description: "Get a subagent's status and report by id (wait: true blocks until it finishes). Without id, lists all subagents.",
      inputSchema: {type: 'object', properties: {id: {type: 'integer'}, wait: {type: 'boolean'}}},
      mutating: false,
      mainOnly: true,
      summarize: (a) => (a?.id === undefined ? 'all' : `#${a.id}${a.wait ? ' (wait)' : ''}`),
      async run(_ctx, args) {
        if (args?.id === undefined) {
          const all = agents.list();
          return {ok: true, text: all.length ? all.map((a) => `#${a.id} ${a.name} · ${a.modelLabel ?? a.requested} · ${a.mode} · ${subagentStatusText(a)}`).join('\n') : 'No subagents.'};
        }
        const a = agents.get(Number(args.id));
        if (!a) throw new ToolError(`no subagent #${args.id}`);
        if (args.wait && agents.isActive(a)) await agents.wait(a.id);
        if (agents.isActive(a)) return {ok: true, text: `Subagent #${a.id} "${a.name}" is ${subagentStatusText(a)}. Call again with wait: true to block until it's done.`};
        a.collected = true;
        return {ok: a.status === 'done', text: report(a)};
      },
    },
  ];
}
