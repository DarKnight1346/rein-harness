import { ToolError } from './fs.js';
const MAX_QUESTIONS = 6;
const MAX_OPTIONS = 8;
/**
 * `ask_user` (main agent): ask one or more multiple-choice questions in one go; the user answers
 * them all (with a free-text "Something else" on each) before the agent continues.
 */
export function askUserTool(present) {
    return {
        name: 'ask_user',
        label: 'Ask',
        description: 'Ask the user questions.',
        describe: () => [
            'Ask the user one or more multiple-choice questions when you need a decision or information you can\'t find yourself (scope, preferences, trade-offs, which option). All questions are shown together; the user answers every one, then you continue with the answers.',
            '- Give 2–6 concrete options per question (label + short description of the consequence). The user can always pick "Something else" and type their own answer.',
            '- multi: true when several options can apply together.',
            '- Batch related questions into one call. Don\'t ask what you can find out by reading the code or the conversation.',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                questions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Short key' },
                            question: { type: 'string' },
                            options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } },
                            multi: { type: 'boolean', description: 'Allow choosing several options' },
                        },
                        required: ['question', 'options'],
                    },
                },
            },
            required: ['questions'],
        },
        mutating: false,
        mainOnly: true,
        summarize: (a) => {
            const n = Array.isArray(a?.questions) ? a.questions.length : 0;
            return `${n} question${n === 1 ? '' : 's'}: ${String(a?.questions?.[0]?.question ?? '').slice(0, 70)}`;
        },
        async run(_ctx, args) {
            const raw = Array.isArray(args?.questions) ? args.questions : [];
            if (!raw.length)
                throw new ToolError('questions is required');
            if (raw.length > MAX_QUESTIONS)
                throw new ToolError(`at most ${MAX_QUESTIONS} questions per call`);
            const questions = raw.map((q, i) => {
                if (typeof q?.question !== 'string' || !q.question.trim())
                    throw new ToolError(`question ${i + 1} needs text`);
                const options = (Array.isArray(q.options) ? q.options : [])
                    .map((o) => (typeof o === 'string' ? { label: o } : { label: String(o?.label ?? ''), description: o?.description ? String(o.description) : undefined }))
                    .filter((o) => o.label.trim());
                if (options.length < 2)
                    throw new ToolError(`question ${i + 1} needs at least 2 options (the user can also type their own)`);
                if (options.length > MAX_OPTIONS)
                    throw new ToolError(`question ${i + 1}: at most ${MAX_OPTIONS} options`);
                return { id: typeof q.id === 'string' && q.id ? q.id : `q${i + 1}`, question: q.question.trim(), options, multi: !!q.multi };
            });
            const ask = present();
            if (!ask)
                return { ok: true, text: 'Nobody is here to answer (headless run): make reasonable assumptions, state them explicitly, and continue.' };
            const answers = await ask(questions);
            if (!answers)
                return { ok: true, text: 'The user dismissed the questions without answering. Ask in plain text if you still need to know, or proceed with stated assumptions.' };
            const lines = questions.map((q) => {
                const a = answers.find((x) => x.id === q.id);
                const parts = [...(a?.selected ?? []), ...(a?.other ? [`(their own answer) ${a.other}`] : [])];
                return `${q.question}\n→ ${parts.length ? parts.join('; ') : '(no answer)'}`;
            });
            return { ok: true, text: `The user answered:\n\n${lines.join('\n\n')}` };
        },
    };
}
