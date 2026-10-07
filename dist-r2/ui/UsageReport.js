import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { PROVIDERS } from '../providers/types.js';
import { clock } from '../session/engine.js';
import { windowLabel } from '../store/usage.js';
import { accountLabel, age, relative } from './format.js';
const BAR = 20;
function bar(pct) {
    const n = Math.max(0, Math.min(BAR, Math.round((pct / 100) * BAR)));
    return { fill: '█'.repeat(n), rest: '░'.repeat(BAR - n), color: pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green' };
}
/** Printed into the transcript (not an overlay), so any number of accounts fits without redraws. */
export function UsageReport({ rows, jev }) {
    return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, marginTop: 1, children: [!rows.length && _jsx(Text, { dimColor: true, children: "No accounts. Use /login." }), rows.map(({ account, snapshot, cooldownUntil, error }) => (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Text, { children: [_jsx(Text, { bold: true, children: PROVIDERS[account.provider].name }), " ", accountLabel(account), account.plan ? _jsxs(Text, { dimColor: true, children: [" \u00B7 ", account.plan] }) : null, cooldownUntil ? _jsxs(Text, { color: "red", children: [" \u00B7 limited until ", clock(cooldownUntil)] }) : null] }), snapshot?.windows.length ? (snapshot.windows.map((w) => {
                        const b = bar(w.usedPct);
                        return (_jsxs(Text, { children: ['  ', windowLabel(w.windowMins).padEnd(7), _jsx(Text, { color: b.color, children: b.fill }), _jsx(Text, { dimColor: true, children: b.rest }), " ", `${Math.round(w.usedPct)}%`.padStart(4), w.resetsAt ? _jsxs(Text, { dimColor: true, children: ["  resets ", clock(w.resetsAt), " (", relative(w.resetsAt), ")"] }) : null] }, w.windowMins));
                    })) : (_jsxs(Text, { dimColor: true, children: ["  no usage data yet", account.provider === 'claude' ? ' (appears after the first request)' : ''] })), snapshot && _jsxs(Text, { dimColor: true, children: ["  updated ", age(snapshot.at)] }), error && _jsxs(Text, { color: "red", children: ["  ", error.slice(0, 120)] })] }, account.id))), _jsxs(Text, { dimColor: true, children: ["Jev: ", jev ? 'API key set' : 'no API key (add one in /login)', " \u00B7 /usage refresh re-checks Claude"] })] }));
}
