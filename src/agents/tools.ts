import {refKey} from '../providers/types.js';
import {catalog, toRef} from '../router/catalog.js';
import type {Config} from '../store/config.js';
import {ToolError} from '../tools/fs.js';
import type {ToolDef} from '../tools/registry.js';
import {subagentStatusText, type Subagent, type SubagentManager} from './manager.js';

const COST = ['', 'very low', 'low', 'medium', 'high', 'very high', 'highest'];

/** Models the user is signed into right now (healthy accounts only). */
function availableModels(cfg: Config) {
  return catalog.available(cfg.maxUsedPct).map((m) => ({value: refKey(toRef(m)), line: `- ${refKey(toRef(m))}: ${m.label} — ${m.description ?? 'general model'} (cost: ${COST[Math.min(6, m.tier)]})`}));
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
        return [
          'Delegate a task to a subagent that works autonomously with the same tools and returns a report.',
          '- mode "fork": branches your current session — it keeps the full conversation history and uses your current model/account (good for parallel work that needs context).',
          '- mode "new": a fresh session with no history on any model below — the task must be self-contained (good for independent work, or to use a cheaper/stronger model).',
          `- model "auto" lets the decision model pick the best model for the task (new mode). Fork mode ignores model.`,
          '- background: true returns an id at once; otherwise this call waits and returns the report.',
          'Two ways to work with subagents — pick per task:',
          '  • Orchestrate: spawn several in the background, then collect each with agent_result {id, wait: true} (you wait while they work).',
          '  • Work alongside: spawn in the background and keep doing your own part with your tools; collect with agent_result when you need the results.',
          '  If you end your turn while background subagents are still running, each report is delivered to you as a message when it finishes.',
          `- A decision model checks each subagent's work and makes it continue if it isn't complete. At most ${cfg.subagentLimit} subagents run at once.`,
          'Models available now:',
          ...models.map((m) => m.line),
        ].join('\n');
      },
      inputSchema: {},
      schema: () => {
        const models = availableModels(config()).map((m) => m.value);
        return {
          type: 'object',
          properties: {
            task: {type: 'string', description: 'Complete, self-contained instructions for the subagent (what to do, where, what to report)'},
            mode: {type: 'string', enum: ['new', 'fork'], description: 'fork = keep this conversation history; new = fresh session'},
            model: {type: 'string', enum: ['auto', ...models], description: 'Model for new mode ("auto" = decision model picks)'},
            name: {type: 'string', description: 'Short name shown to the user (e.g. "test-writer")'},
            background: {type: 'boolean', description: 'Return immediately; collect later with agent_result'},
          },
          required: ['task', 'mode'],
        };
      },
      mutating: false,
      mainOnly: true,
      summarize: (a) => `${a?.name ?? 'agent'} · ${a?.mode === 'fork' ? 'fork' : a?.model ?? 'auto'}${a?.background ? ' · background' : ''}`,
      async run(_ctx, args) {
        if (typeof args?.task !== 'string' || !args.task.trim()) throw new ToolError('task is required');
        const mode = args.mode === 'fork' ? 'fork' : 'new';
        const model = typeof args.model === 'string' && args.model ? args.model : 'auto';
        let spawned;
        try {
          spawned = agents.spawn({task: args.task, mode, model, name: args.name, background: !!args.background});
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
