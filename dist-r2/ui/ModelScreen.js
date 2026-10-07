import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TabBar } from './TabBar.js';
import { PROVIDERS, parseRef, refKey } from '../providers/types.js';
import { runtime } from '../runtime.js';
import { catalog, toRef } from '../router/catalog.js';
import { defaultRef } from '../router/index.js';
import { getJevKey } from '../store/secrets.js';
import { modelLabel } from './format.js';
import { Clickable } from './terminal/clicks.js';
const SECTIONS = [
    { id: 'chat', title: 'Chat model', key: 'chatModel' },
    { id: 'subagent', title: 'Subagents', key: 'subagentModel' },
    { id: 'priority', title: 'Subagent priority', key: 'subagentPriority' },
    { id: 'decision', title: 'Decision model', key: 'decisionModel' },
    { id: 'compaction', title: 'Compaction model', key: 'compactionModel' },
    { id: 'advisor', title: 'Advisor', key: 'advisorModel' },
    { id: 'web', title: 'Web', key: 'webModel' },
];
/** Rows of the model list shown per section; keeps the overlay short so it never fills the screen. */
const MAX_ROWS = 9;
export function ModelScreen({ onClose, onLog, bare }) {
    const [section, setSection] = useState(0);
    const [cursor, setCursor] = useState(0);
    const [hasJev, setHasJev] = useState(false);
    const [, setTick] = useState(0);
    useEffect(() => {
        void getJevKey().then((k) => setHasJev(!!k));
    }, []);
    const cfg = runtime.config;
    const sec = SECTIONS[section];
    const options = optionsFor(sec.id, hasJev, cfg);
    const current = currentValue(sec.id, cfg);
    // Choosing a chat model continues to its effort level (auto, the model's default, or a level).
    const [effortStep, setEffortStep] = useState();
    const choose = (idx) => {
        const opt = options[idx];
        if (!opt || opt.disabled)
            return;
        void runtime.setConfig({ [sec.key]: opt.value }).then(() => {
            onLog('info', `${sec.title}: ${opt.label}`);
            setTick((t) => t + 1);
            if (sec.id === 'chat') {
                setEffortStep({ label: opt.label, options: effortOptions(opt.value) });
                setCursor(Math.max(0, effortOptions(opt.value).findIndex((o) => o.value === (cfg.chatEffort ?? 'auto'))));
            }
        });
    };
    const chooseEffort = (idx) => {
        const opt = effortStep?.options[idx];
        if (!opt)
            return;
        void runtime.setConfig({ chatEffort: opt.value }).then(() => {
            onLog('info', `Effort: ${opt.label}`);
            setEffortStep(undefined);
            setCursor(0);
        });
    };
    const showSection = (i) => {
        setSection((i + SECTIONS.length) % SECTIONS.length);
        setCursor(0);
    };
    useInput((input, key) => {
        if (effortStep) {
            if (key.escape)
                return setEffortStep(undefined);
            if (key.upArrow)
                setCursor((c) => Math.max(0, c - 1));
            else if (key.downArrow)
                setCursor((c) => Math.min(effortStep.options.length - 1, c + 1));
            else if (key.return)
                chooseEffort(cursor);
            return;
        }
        if (key.escape || input === 'q')
            return onClose();
        if (key.tab || key.rightArrow)
            showSection(section + 1);
        else if (key.leftArrow)
            showSection(section - 1);
        else if (key.upArrow)
            setCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow)
            setCursor((c) => Math.min(options.length - 1, c + 1));
        else if (key.return)
            choose(cursor);
    });
    const wheel = (dir) => setCursor((c) => Math.max(0, Math.min(options.length - 1, c + dir)));
    if (effortStep) {
        return (_jsxs(Box, { flexDirection: "column", ...(bare ? {} : { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 }), children: [_jsxs(Text, { bold: true, children: ["Effort for ", effortStep.label] }), _jsx(Text, { dimColor: true, children: "How hard the model thinks. Changing it mid-conversation discards the prompt cache, so auto only changes it when the cache is cold anyway." }), _jsx(Box, { flexDirection: "column", marginY: 1, children: effortStep.options.map((o, i) => (_jsx(Clickable, { onHover: () => setCursor(i), onClick: () => chooseEffort(i), children: _jsxs(Text, { color: i === cursor ? 'cyan' : undefined, wrap: "truncate", children: [i === cursor ? '❯ ' : '  ', o.value === (cfg.chatEffort ?? 'auto') ? '● ' : '○ ', o.label, o.hint ? _jsxs(Text, { dimColor: true, children: ["  ", o.hint] }) : null] }) }, o.value))) }), _jsx(Text, { dimColor: true, children: "enter choose \u00B7 esc keep current" })] }));
    }
    const start = Math.max(0, Math.min(cursor - Math.floor(MAX_ROWS / 2), options.length - MAX_ROWS));
    const visible = options.slice(start, start + MAX_ROWS);
    return (_jsxs(Box, { flexDirection: "column", ...(bare ? {} : { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 }), children: [_jsx(TabBar, { titles: SECTIONS.map((s) => s.title), active: section, onSelect: showSection }), _jsx(Text, { dimColor: true, children: describe(sec.id) }), _jsxs(Box, { flexDirection: "column", marginY: 1, children: [start > 0 && (_jsx(Clickable, { onClick: () => wheel(-1), onWheel: wheel, children: _jsx(Text, { dimColor: true, children: "  \u2191 more" }) })), visible.map((o, i) => {
                        const idx = start + i;
                        const selected = o.value === current;
                        return (_jsx(Clickable, { onHover: () => setCursor(idx), onClick: () => choose(idx), onWheel: wheel, children: _jsxs(Text, { color: idx === cursor ? 'cyan' : undefined, dimColor: o.disabled, wrap: "truncate", children: [idx === cursor ? '❯ ' : '  ', selected ? '● ' : '○ ', o.label, o.hint ? _jsxs(Text, { dimColor: true, children: ["  ", o.hint] }) : null] }) }, o.value));
                    }), start + MAX_ROWS < options.length && (_jsx(Clickable, { onClick: () => wheel(1), onWheel: wheel, children: _jsx(Text, { dimColor: true, children: "  \u2193 more" }) }))] }), _jsx(Text, { dimColor: true, children: "click or \u2190\u2192/tab section \u00B7 \u2191\u2193 select \u00B7 enter choose \u00B7 esc close" })] }));
}
const EFFORT_HINTS = {
    low: 'fastest, cheapest',
    medium: 'balanced',
    high: 'harder problems',
    xhigh: 'very hard problems',
    max: 'may use excessive tokens — hardest tasks only',
    ultra: 'maximum reasoning (Codex)',
};
/** Effort choices for a chat model value (a ref, or 'auto' → the union of common levels). */
function effortOptions(value) {
    const ref = value === 'auto' ? undefined : parseRef(value);
    const m = ref ? catalog.get(ref) : undefined;
    const levels = m?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];
    return [
        { value: 'auto', label: 'Auto', hint: 'the decision model picks per task (when the cache is cold)' },
        { value: 'default', label: 'Model default', hint: m?.defaultEffort ? `currently ${m.defaultEffort}` : 'whatever the model uses by default' },
        ...levels.map((l) => ({ value: l, label: l, hint: EFFORT_HINTS[l] })),
    ];
}
function describe(s) {
    if (s === 'chat')
        return 'Model that answers you. auto = the decision model routes each task.';
    if (s === 'decision')
        return 'Routes auto mode and picks failover models. Jev if you have a key; else a cheap model with strict prompts.';
    if (s === 'subagent')
        return 'Your model for new subagents (auto = none). Whether it overrides the agent\'s own pick is set in Subagent priority. Forked subagents keep the current model.';
    if (s === 'priority')
        return 'Order used to choose a new subagent\'s model. Forked subagents always keep the current agent\'s model.';
    if (s === 'web')
        return 'Runs web_search with its provider\'s built-in search, and reads fetched pages for web_fetch. Any signed-in Claude or Codex model works.';
    if (s === 'advisor')
        return 'A stronger (pricier) model agents can consult via the advisor tool for guidance at key moments. Off by default; never auto.';
    return 'Summarizes the conversation for /compact, long chats and handoffs between models.';
}
function modelOptions(models) {
    return models.map((m) => ({
        value: refKey(toRef(m)),
        label: `${m.label}`,
        hint: `${PROVIDERS[m.provider].name}${m.description ? ` · ${truncate(m.description, 60)}` : ''}`,
    }));
}
function optionsFor(s, hasJev, cfg) {
    const models = catalog.all();
    const cheapest = catalog.cheapest(cfg.maxUsedPct);
    const cheapestHint = cheapest ? `currently ${cheapest.label}` : 'no model available';
    if (s === 'chat') {
        const decider = cfg.decisionModel === 'jev' && hasJev ? 'Jev' : 'the decision model';
        return [{ value: 'auto', label: 'auto', hint: `${decider} picks per task` }, ...modelOptions(models)];
    }
    if (s === 'subagent') {
        return [{ value: 'auto', label: 'auto', hint: 'no model of your own: the agent picks, or the decision model' }, ...modelOptions(models)];
    }
    if (s === 'priority') {
        return [
            { value: 'user', label: 'Your model first', hint: 'your Subagents model → the agent\'s choice → auto (default)' },
            { value: 'agent', label: 'Agent\'s choice first', hint: 'the agent\'s choice → your Subagents model → auto' },
        ];
    }
    if (s === 'decision') {
        return [
            { value: 'jev', label: 'Jev', hint: hasJev ? 'typesafe.ai · fast, ~free' : 'add a Jev API key in /login first', disabled: !hasJev },
            { value: 'cheapest', label: 'Cheapest available', hint: cheapestHint },
            ...modelOptions(models),
        ];
    }
    if (s === 'advisor') {
        // Most capable first: that's what an advisor is for.
        return [{ value: 'off', label: 'Off', hint: 'agents get no advisor tool' }, ...modelOptions([...models].sort((a, b) => b.tier - a.tier))];
    }
    return [{ value: 'cheapest', label: 'Cheapest available', hint: cheapestHint }, ...modelOptions(models)];
}
function currentValue(s, cfg) {
    if (s === 'chat') {
        if (cfg.chatModel)
            return cfg.chatModel;
        const d = defaultRef(cfg);
        return d ? refKey(d) : '';
    }
    if (s === 'subagent')
        return cfg.subagentModel ?? 'auto';
    if (s === 'priority')
        return cfg.subagentPriority ?? 'user';
    return s === 'decision' ? cfg.decisionModel : s === 'advisor' ? cfg.advisorModel : s === 'web' ? cfg.webModel : cfg.compactionModel;
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** `/model <query>`: `auto`, a ref (`codex:gpt-6-luna`), an id or a label. */
export function resolveModelQuery(query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return undefined;
    if (q === 'auto')
        return 'auto';
    const ref = parseRef(q);
    if (ref && catalog.get(ref))
        return refKey(ref);
    const m = catalog.all().find((x) => x.id.toLowerCase() === q || x.label.toLowerCase() === q);
    return m ? refKey(toRef(m)) : undefined;
}
export const describeChatModel = (value) => (value === 'auto' ? 'auto' : modelLabel(parseRef(value) ?? { provider: 'claude', model: value }));
