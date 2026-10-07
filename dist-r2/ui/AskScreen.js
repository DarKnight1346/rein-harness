import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import { Clickable } from './terminal/clicks.js';
/**
 * The agent's questions, one at a time: ↑↓ move, enter picks (multi: space toggles, enter confirms),
 * the last row "Something else" takes typed text, ←→ switch questions; after the last question the
 * answers go back together. Esc dismisses.
 */
export function AskScreen({ questions, onDone }) {
    const [index, setIndex] = useState(0);
    const [cursor, setCursor] = useState(0);
    const [answers, setAnswers] = useState(questions.map((q) => ({ id: q.id, selected: [] })));
    const q = questions[index];
    const a = answers[index];
    const otherRow = q.options.length; // "Something else"
    const typing = cursor === otherRow;
    const update = (patch) => setAnswers((all) => all.map((x, i) => (i === index ? { ...x, ...patch } : x)));
    const next = (latest = answers) => {
        if (index < questions.length - 1) {
            setIndex(index + 1);
            setCursor(0);
        }
        else
            onDone(latest);
    };
    const pick = (i) => {
        const label = q.options[i].label;
        if (q.multi)
            update({ selected: a.selected.includes(label) ? a.selected.filter((l) => l !== label) : [...a.selected, label] });
        else {
            const latest = answers.map((x, k) => (k === index ? { ...x, selected: [label], other: undefined } : x));
            setAnswers(latest);
            next(latest);
        }
    };
    useInput((input, key) => {
        if (key.escape)
            return onDone(undefined);
        if (key.upArrow)
            return setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow)
            return setCursor((c) => Math.min(otherRow, c + 1));
        if (typing)
            return; // the text box handles keys
        if (key.leftArrow && index > 0)
            return (setIndex(index - 1), setCursor(0));
        if (key.rightArrow && index < questions.length - 1)
            return (setIndex(index + 1), setCursor(0));
        if (input === ' ' && q.multi)
            return pick(cursor);
        if (key.return) {
            if (q.multi)
                next();
            else
                pick(cursor);
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["Question ", index + 1, " of ", questions.length, q.multi ? ' · choose any' : ''] }), _jsx(Text, { bold: true, wrap: "wrap", children: q.question }), _jsxs(Box, { flexDirection: "column", marginY: 1, children: [q.options.map((o, i) => {
                        const chosen = a.selected.includes(o.label);
                        return (_jsx(Clickable, { onHover: () => setCursor(i), onClick: () => (setCursor(i), pick(i)), children: _jsxs(Text, { wrap: "truncate", color: i === cursor ? 'cyan' : undefined, children: [i === cursor ? '❯ ' : '  ', q.multi ? (chosen ? '[x] ' : '[ ] ') : chosen ? '● ' : '○ ', o.label, o.description ? _jsxs(Text, { dimColor: true, children: [" \u2014 ", o.description] }) : null] }) }, o.label));
                    }), _jsxs(Box, { children: [_jsxs(Text, { color: typing ? 'cyan' : undefined, children: [typing ? '❯ ' : '  ', "Something else: "] }), typing ? (_jsx(TextInput, { value: a.other ?? '', onChange: (v) => update({ other: v }), placeholder: "type your answer, enter to continue", onSubmit: (v) => {
                                    const latest = answers.map((x, k) => (k === index ? { ...x, other: v.trim() || undefined, selected: q.multi ? x.selected : [] } : x));
                                    setAnswers(latest);
                                    next(latest);
                                } })) : (_jsx(Text, { dimColor: true, children: a.other ?? '(↓ to type)' }))] })] }), _jsxs(Text, { dimColor: true, children: [q.multi ? 'space toggle · enter next' : 'enter choose', " \u00B7 \u2191\u2193 move", questions.length > 1 ? ' · ←→ question' : '', " \u00B7 esc dismiss"] })] }));
}
