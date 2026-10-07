import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
const COLS = 20;
const ROWS = 8; // 160 cells, room for every legend line
const COLOR = { system: 'gray', tools: 'yellow', summary: 'magenta', messages: 'cyan', calls: 'green', other: 'blue' };
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const pct = (n, of) => `${((n / of) * 100).toFixed(1)}%`;
/** `/context`: a usage grid like Claude Code's, one cell per 1% of the model's window. */
export function ContextView({ report }) {
    const { window, categories, used } = report;
    // Fill cells in category order; any non-zero category gets at least one cell.
    const cells = [];
    for (const c of categories) {
        const n = c.tokens ? Math.max(1, Math.round((c.tokens / window) * COLS * ROWS)) : 0;
        for (let i = 0; i < n && cells.length < COLS * ROWS; i++)
            cells.push(c.key);
    }
    while (cells.length < COLS * ROWS)
        cells.push('free');
    const legend = [
        _jsxs(Text, { bold: true, children: [report.modelLabel, " \u00B7 ", k(report.measured ?? used), "/", k(window), " tokens (", pct(report.measured ?? used, window), report.measured !== undefined ? ', measured' : ', est.', ")"] }, "h"),
        ...categories.map((c) => (_jsxs(Text, { children: [_jsx(Text, { color: COLOR[c.key], children: "\u26C1" }), " ", c.label, ": ", _jsx(Text, { bold: true, children: k(c.tokens) }), _jsxs(Text, { dimColor: true, children: [" (", pct(c.tokens, window), ")"] })] }, c.key))),
        _jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: "\u26F6" }), " Free space: ", k(Math.max(0, window - used)), _jsxs(Text, { dimColor: true, children: [" (", pct(Math.max(0, window - used), window), ")"] })] }, "free"),
    ];
    return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, marginTop: 1, children: [_jsxs(Box, { children: [_jsx(Box, { flexDirection: "column", marginRight: 3, children: Array.from({ length: ROWS }, (_, r) => (_jsx(Text, { children: cells.slice(r * COLS, (r + 1) * COLS).map((c, i) => c === 'free' ? (_jsxs(Text, { dimColor: true, children: ["\u26F6", ' '] }, i)) : (_jsxs(Text, { color: COLOR[c], children: ["\u26C1", ' '] }, i))) }, r))) }), _jsx(Box, { flexDirection: "column", children: legend })] }), _jsxs(Text, { dimColor: true, children: [report.messageCount, " messages", report.summarizedCount ? ` · ${report.summarizedCount} folded into the summary` : '', report.measured !== undefined ? ` · last request measured ${k(report.measured)} input tokens` : ' · estimates (~4 chars/token)', report.autoCompactAt ? ` · auto-compacts at ${k(report.autoCompactAt)}` : ' · auto-compact off'] })] }));
}
