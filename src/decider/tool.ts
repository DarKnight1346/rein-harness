import type {Config} from '../store/config.js';
import {ToolError} from '../tools/fs.js';
import type {ToolDef} from '../tools/registry.js';
import {decide} from './index.js';
import type {Questions} from './types.js';

const MAX_QUESTIONS = 25;
const MAX_CONTEXT = 60_000;

type Q = {id?: string; type?: string; question?: string; options?: Record<string, string> | string[]; scale?: string[]; yes?: string; no?: string};

/**
 * `decide`: the agent hands small, well-defined judgments to the decision model (Jev, or the cheapest
 * signed-in model with strict prompts) instead of spending its own expensive reasoning — triage,
 * classification, picking between options, yes/no checks over text it already has.
 */
export function decideTool(config: () => Config): ToolDef {
  return {
    name: 'decide',
    label: 'Decide',
    description: 'Ask the cheap decision model.',
    describe: () =>
      [
        'Hand small, well-defined judgments to the cheap decision model instead of reasoning them out yourself: classify or triage items, pick between options, yes/no checks, ratings. Fast and much cheaper than you; several questions per call.',
        '- context: everything the judgment needs (it sees nothing else — paste the text, error, diff or list).',
        '- questions: [{id, type, question, …}] with type "yes_no" (answer = probability of yes; optional yes/no criteria), "choice" (options: {"name": "what it means"} or ["a","b"]), or "score" (scale: descriptions from lowest to highest).',
        '- Not for open-ended reasoning, code, or anything needing tools — it just answers the questions.',
      ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        context: {type: 'string', description: 'The information to judge (pasted in full)'},
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: {type: 'string', description: 'Short key for the answer'},
              type: {type: 'string', enum: ['yes_no', 'choice', 'score']},
              question: {type: 'string'},
              options: {description: 'choice: {"option": "meaning"} or a list of options', anyOf: [{type: 'object', additionalProperties: {type: 'string'}}, {type: 'array', items: {type: 'string'}}]},
              scale: {type: 'array', items: {type: 'string'}, description: 'score: what each level means, lowest first'},
              yes: {type: 'string', description: 'yes_no: what counts as yes'},
              no: {type: 'string', description: 'yes_no: what counts as no'},
            },
            required: ['type', 'question'],
          },
        },
      },
      required: ['context', 'questions'],
    },
    mutating: false,
    summarize: (a) => `${Array.isArray(a?.questions) ? a.questions.length : 0} question${a?.questions?.length === 1 ? '' : 's'}: ${String(a?.questions?.[0]?.question ?? '').slice(0, 60)}`,
    async run(_ctx, args) {
      const list: Q[] = Array.isArray(args?.questions) ? args.questions : [];
      if (!list.length) throw new ToolError('questions is required');
      if (list.length > MAX_QUESTIONS) throw new ToolError(`at most ${MAX_QUESTIONS} questions per call`);
      const context = String(args?.context ?? '').slice(0, MAX_CONTEXT);
      const questions: Questions = {};
      const ids = list.map((q, i) => (q.id && /^[\w-]{1,40}$/.test(q.id) ? q.id : `q${i + 1}`));
      list.forEach((q, i) => {
        const id = ids[i]!;
        if (typeof q.question !== 'string' || !q.question.trim()) throw new ToolError(`question ${id} needs text`);
        if (q.type === 'yes_no') {
          questions[id] = {type: 'noul', instructions: q.question, criteria: q.yes || q.no ? {true: q.yes ?? 'yes', false: q.no ?? 'no'} : null};
        } else if (q.type === 'choice') {
          const opts = Array.isArray(q.options) ? Object.fromEntries(q.options.map((o) => [String(o), String(o)])) : (q.options ?? {});
          if (Object.keys(opts).length < 2) throw new ToolError(`question ${id}: a choice needs at least 2 options`);
          questions[id] = {type: 'choice', instructions: q.question, criteria: opts};
        } else if (q.type === 'score') {
          if (!Array.isArray(q.scale) || q.scale.length < 2) throw new ToolError(`question ${id}: a score needs a scale of at least 2 levels`);
          questions[id] = {type: 'score', instructions: q.question, criteria: q.scale};
        } else throw new ToolError(`question ${id}: type must be yes_no, choice or score`);
      });
      const d = await decide(config(), {context}, questions);
      const lines = list.map((q, i) => {
        const id = ids[i]!;
        const a = d.answers[id];
        if (!a) return `${id}: no answer`;
        if (a.type === 'noul') return `${id}: ${a.noul >= 0.5 ? 'yes' : 'no'} (p(yes) = ${a.noul.toFixed(2)})`;
        if (a.type === 'choice') return `${id}: ${a.choice} (confidence ${a.confidence.toFixed(2)})`;
        // Scores are positions on the scale: 0 = first (lowest) level … n-1 = last.
        const n = q.scale?.length ?? 0;
        const level = q.scale?.[Math.max(0, Math.min(n - 1, Math.round(a.score)))];
        return `${id}: ${a.score.toFixed(2)} on 0–${n - 1}${level ? ` ≈ "${level}"` : ''} (confidence ${a.confidence.toFixed(2)})`;
      });
      return {ok: true, text: `${lines.join('\n')}\n(via ${d.backend})`};
    },
  };
}
