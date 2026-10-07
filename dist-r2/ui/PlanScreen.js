import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { renderMarkdown } from './markdown.js';
import { Clickable } from './terminal/clicks.js';
const OPTIONS = [
    ['implement', '1 Save & implement now'],
    ['goal', '2 Save & start as a goal — tracked milestones, verified as it goes'],
    ['save', '3 Save only — start it later with /goal:plan'],
    ['revise', '4 Keep planning — I\'ll give feedback'],
];
/** The agent's plan (markdown + milestones, scrollable); every choice but "keep planning" saves it to .rein/plans/. */
export function PlanScreen({ plan, width, onDecide }) {
    const { rows } = useWindowSize();
    const body = plan.plan.replace(/^#\s+.*\n+/, '');
    const md = `# ${plan.title}\n\n${body}\n\n## Milestones\n${plan.milestones.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
    const lines = renderMarkdown(md, Math.max(20, width));
    const viewport = Math.max(4, Math.min(lines.length, rows - 14));
    const [top, setTop] = useState(0);
    const maxTop = Math.max(0, lines.length - viewport);
    useInput((input, key) => {
        if (input === '1' || key.return)
            onDecide('implement');
        else if (input === '2')
            onDecide('goal');
        else if (input === '3')
            onDecide('save');
        else if (input === '4' || key.escape)
            onDecide('revise');
        else if (key.upArrow)
            setTop((t) => Math.max(0, t - 1));
        else if (key.downArrow)
            setTop((t) => Math.min(maxTop, t + 1));
        else if (key.pageUp)
            setTop((t) => Math.max(0, t - viewport));
        else if (key.pageDown)
            setTop((t) => Math.min(maxTop, t + viewport));
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Clickable, { onWheel: (dir) => setTop((t) => Math.max(0, Math.min(maxTop, t + dir * 3))), children: _jsx(Box, { flexDirection: "column", height: viewport, overflow: "hidden", children: lines.slice(top, top + viewport).map((l, i) => (_jsx(Text, { wrap: "truncate", children: l || ' ' }, i))) }) }), lines.length > viewport && _jsx(Text, { dimColor: true, children: `${top + 1}–${Math.min(lines.length, top + viewport)} of ${lines.length} · ↑↓ scroll` }), _jsx(Box, { marginTop: 1, flexDirection: "column", children: OPTIONS.map(([d, label]) => (_jsx(Clickable, { onClick: () => onDecide(d), children: _jsxs(Text, { color: d === 'revise' ? 'yellow' : 'green', children: ["[", label, "]"] }) }, d))) })] }));
}
