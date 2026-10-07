import { completeWith } from '../decider/index.js';
import { parseRef } from '../providers/types.js';
import { catalog, toRef } from '../router/catalog.js';
/** The model to use: a hinted one you have, else by the server's priorities (smart → the chat model, cheap/fast → the cheapest). */
export function pickSamplingModel(params, cfg) {
    const healthy = catalog.available(cfg.maxUsedPct);
    for (const hint of params.modelPreferences?.hints ?? []) {
        const h = (hint.name ?? '').toLowerCase();
        if (!h)
            continue;
        const m = healthy.find((x) => x.id.toLowerCase().includes(h) || x.label.toLowerCase().includes(h)) ?? healthy.find((x) => h.includes(x.provider === 'claude' ? 'claude' : 'gpt') && x.isDefault);
        if (m)
            return toRef(m);
    }
    const p = params.modelPreferences ?? {};
    const smart = (p.intelligencePriority ?? 0.5) >= Math.max(p.costPriority ?? 0.5, p.speedPriority ?? 0.5);
    if (smart) {
        const chat = cfg.chatModel && cfg.chatModel !== "auto" ? parseRef(cfg.chatModel) : undefined;
        if (chat && catalog.healthyAccounts(chat, cfg.maxUsedPct).length)
            return chat;
        const d = catalog.defaultModel(cfg.maxUsedPct);
        if (d)
            return toRef(d);
    }
    const c = catalog.cheapest(cfg.maxUsedPct);
    return c ? toRef(c) : undefined;
}
const textOf = (content) => {
    const parts = Array.isArray(content) ? content : [content];
    return parts.map((c) => (c.type === 'text' ? c.text : `[${c.type} omitted]`)).join('\n');
};
/** The conversation the server sent, as one prompt for a one-shot completion. */
export function samplingPrompt(params) {
    const turns = params.messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${textOf(m.content)}`);
    const limit = params.maxTokens ? `\nKeep the reply under about ${params.maxTokens} tokens.` : '';
    const stops = params.stopSequences?.length ? `\nStop before any of: ${params.stopSequences.map((s) => JSON.stringify(s)).join(', ')}.` : '';
    return {
        system: `${params.systemPrompt?.trim() || 'You are a helpful assistant.'}${limit}${stops}\nReply with the assistant's next message only.`,
        prompt: params.messages.length === 1 && params.messages[0].role === 'user' ? textOf(params.messages[0].content) : `${turns.join('\n\n')}\n\nAssistant:`,
    };
}
export function samplingHandler(deps) {
    const allowed = new Set();
    return async (server, params) => {
        const cfg = deps.config();
        const mode = cfg.mcpSampling ?? 'ask';
        if (mode === 'off')
            throw new Error('sampling is turned off in Rein (mcpSampling: "off")');
        const ref = pickSamplingModel(params, cfg);
        if (!ref)
            throw new Error('no signed-in model is available');
        const { system, prompt } = samplingPrompt(params);
        if (mode === 'ask' && !allowed.has(server)) {
            const preview = `${system}\n\n${prompt}`.slice(0, 1500);
            const d = deps.approve ? await deps.approve(server, ref, preview) : 'deny';
            if (d === 'deny')
                throw new Error('the user declined this sampling request');
            if (d === 'session')
                allowed.add(server);
        }
        const text = await (deps.complete ?? ((r, c, s, p) => completeWith(r, c, s, p, { timeoutMs: 180_000 })))(ref, cfg, system, prompt);
        return { role: 'assistant', content: { type: 'text', text }, model: catalog.get(ref)?.label ?? ref.model, stopReason: 'endTurn' };
    };
}
