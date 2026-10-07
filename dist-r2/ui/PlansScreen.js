import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { progress } from '../plans/store.js';
import { age } from './format.js';
import { Clickable } from './terminal/clicks.js';
/** /goal:plan: pick an unfinished saved plan to start as a goal, or start planning a new one. */
export function PlansScreen({ plans, onPick, onNew, onCancel }) {
    const [cursor, setCursor] = useState(0);
    const rows = plans.length + 1; // + "start a new plan"
    const choose = (i) => (i < plans.length ? onPick(plans[i]) : onNew());
    useInput((input, key) => {
        if (key.escape || input === 'q')
            onCancel();
        else if (key.upArrow)
            setCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow)
            setCursor((c) => Math.min(rows - 1, c + 1));
        else if (key.return)
            choose(cursor);
    });
    return (_jsxs(Box, { flexDirection: "column", children: [plans.length ? _jsx(Text, { dimColor: true, children: "Unfinished plans in .rein/plans/ (newest first):" }) : _jsx(Text, { dimColor: true, children: "No unfinished plans in .rein/plans/ yet." }), _jsxs(Box, { flexDirection: "column", marginY: 1, children: [plans.map((p, i) => {
                        const g = progress(p);
                        return (_jsx(Clickable, { onHover: () => setCursor(i), onClick: () => onPick(p), children: _jsxs(Text, { wrap: "truncate", color: i === cursor ? 'cyan' : undefined, children: [i === cursor ? '❯ ' : '  ', p.title, _jsxs(Text, { dimColor: true, children: [' ', "\u00B7 ", g.done, "/", g.total, " milestones \u00B7 ", age(p.savedAt)] })] }) }, p.file));
                    }), _jsx(Clickable, { onHover: () => setCursor(plans.length), onClick: onNew, children: _jsxs(Text, { color: cursor === plans.length ? 'cyan' : 'green', children: [cursor === plans.length ? '❯ ' : '  ', "\u270E Start a new plan"] }) })] }), _jsx(Text, { dimColor: true, children: "enter start as a goal \u00B7 \u2191\u2193 select \u00B7 esc close" })] }));
}
