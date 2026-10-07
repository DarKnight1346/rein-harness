import { decide } from '../decider/index.js';
import { refKey } from '../providers/types.js';
import { catalog, toRef } from './catalog.js';
import { defaultRef } from './index.js';
/** Head+tail of long messages: the decider never sees more than ~1.5k tokens of input. */
const HEAD_CHARS = 3600;
const TAIL_CHARS = 2400;
export function headTail(text) {
    if (text.length <= HEAD_CHARS + TAIL_CHARS)
        return text;
    return `${text.slice(0, HEAD_CHARS)}\n…[${text.length - HEAD_CHARS - TAIL_CHARS} chars omitted]…\n${text.slice(-TAIL_CHARS)}`;
}
const COST = ['', 'very low', 'low', 'medium', 'high', 'very high', 'highest'];
/** Fixed per-model descriptions (stable text keeps the decider calibrated). */
function describeModel(m) {
    return `${m.label}: ${m.description ?? 'general-purpose model'} Cost: ${COST[Math.min(m.tier, 6)] ?? 'medium'}.`;
}
/** Fisher–Yates; option order is shuffled every call to counter first-option bias. */
export function shuffle(items, rand = Math.random) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
/**
 * `/model auto`: one decider call with ≤2 questions and minimal state (never the transcript).
 * Candidates are filtered in code first; one candidate → no call at all. Sticky by default.
 */
export function makeAutoRouter(deps) {
    return async function autoRoute(text, t, current, exclude) {
        const cfg = deps.config();
        const candidates = catalog.available(cfg.maxUsedPct, exclude);
        if (!candidates.length)
            throw new Error('no models available — sign in with /login or wait for a limit to reset');
        if (candidates.length === 1)
            return { ref: toRef(candidates[0]), reason: 'auto', confidence: 1 };
        const currentOk = current && candidates.some((m) => refKey(toRef(m)) === refKey(current));
        const userTurns = t.messages.filter((m) => m.role === 'user').length;
        const midConversation = !!currentOk && userTurns > 1;
        const criteria = {};
        for (const m of shuffle(candidates))
            criteria[refKey(toRef(m))] = describeModel(m);
        const questions = {
            model: {
                type: 'choice',
                instructions: 'Which model should answer the new message? Pick the cheapest model that will answer it well; reserve expensive models for genuinely hard reasoning, large code or high-stakes work.',
                criteria,
            },
        };
        if (midConversation) {
            questions.switch = {
                type: 'noul',
                instructions: 'Does the new message start a materially different kind of task than the current task, one that likely needs a different capability level?',
                criteria: { true: 'new kind of task (e.g. casual chat → hard debugging, or the reverse)', false: 'continues or refines the current task' },
            };
        }
        const state = {
            new_message: headTail(text),
            ...(midConversation ? { current_model: current.model, current_task: t.taskTag ?? '', turn: userTurns } : {}),
        };
        const decision = await decide(cfg, state, questions);
        const sw = decision.answers.switch;
        if (midConversation && sw?.type === 'noul' && sw.noul < cfg.autoSwitchThreshold) {
            deps.onDecision?.(`stay (switch ${sw.noul.toFixed(2)}) via ${decision.backend}`);
            return { ref: current, reason: 'sticky', confidence: 1 - sw.noul };
        }
        t.taskTag = text.replace(/\s+/g, ' ').slice(0, 80);
        const pick = decision.answers.model;
        if (pick?.type !== 'choice')
            throw new Error('decider returned no model choice');
        const chosen = candidates.find((m) => refKey(toRef(m)) === pick.choice);
        deps.onDecision?.(`${pick.choice} (${pick.confidence.toFixed(2)}) via ${decision.backend}`);
        if (!chosen || pick.confidence < cfg.autoMinConfidence) {
            const def = defaultRef(cfg);
            const defOk = def && candidates.some((m) => refKey(toRef(m)) === refKey(def));
            return { ref: defOk ? def : toRef(chosen ?? candidates[0]), reason: 'default', confidence: pick.confidence };
        }
        return { ref: toRef(chosen), reason: 'auto', confidence: pick.confidence };
    };
}
