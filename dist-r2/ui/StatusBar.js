import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { runtime } from '../runtime.js';
import { usageStore } from '../store/usage.js';
import { enabledItems, statusInfo } from './layout.js';
import { useShellsTick } from './fullscreen/Shells.js';
/** Classic renderer's status line: the configured segments as plain text (`/settings`). */
export function StatusBar({ tick }) {
    const [, setUsageTick] = useState(0);
    useEffect(() => usageStore.subscribe(() => setUsageTick((t) => t + 1)), []);
    void tick;
    useShellsTick();
    const info = statusInfo();
    const background = runtime.tools.shells.running({ background: true }).length;
    const parts = enabledItems('status', runtime.config).flatMap((id) => {
        switch (id) {
            case 'model':
                return [info.model];
            case 'account':
                return [info.account];
            case 'usage':
                return info.usage ? [info.usage] : [];
            case 'context':
                return [`ctx ${info.context}%`];
            case 'decider':
                return [`decides: ${info.decider}`];
            case 'messages':
                return [`${info.messages} msgs`];
            case 'approvals':
                return [`edits: ${info.approvals}`];
            case 'advisor':
                return [`advisor: ${info.advisor}`];
            default:
                return []; // sidebarToggle: fullscreen only
        }
    });
    return (_jsxs(Text, { dimColor: true, children: ['  ', "rein", parts.length ? ` · ${parts.join(' · ')}` : '', background ? _jsxs(Text, { color: "yellow", children: [" \u00B7 \u25CF ", background, " background (/shells)"] }) : null, runtime.planMode ? _jsx(Text, { color: "yellow", children: " \u00B7 \u23F8 plan mode" }) : null, runtime.ide ? _jsxs(Text, { color: "cyan", children: [" \u00B7 \u29C9 ", runtime.ide.lock.ideName, runtime.ide.selection ? ` · ${runtime.ide.selection.endLine - runtime.ide.selection.startLine + 1} lines selected` : ''] }) : null, runtime.goals.goal ? _jsxs(Text, { color: "cyan", children: [" \u00B7 \u25CE goal ", runtime.goals.goal.status] }) : null] }));
}
