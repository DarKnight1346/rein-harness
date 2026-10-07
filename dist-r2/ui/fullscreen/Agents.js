import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { runtime } from '../../runtime.js';
import { subagentStatusText } from '../../agents/manager.js';
import { Clickable } from '../terminal/clicks.js';
import { Window } from './Window.js';
/** Re-render on subagent updates, at most ~10×/s (streaming text is chatty). */
export function useAgentsTick() {
    const [, setTick] = useState(0);
    useEffect(() => {
        let timer;
        const onChange = () => {
            if (!timer)
                timer = setTimeout(() => ((timer = undefined), setTick((t) => t + 1)), 100);
        };
        runtime.agents.on('change', onChange);
        const clock = setInterval(onChange, 1000); // keep "running 12s" fresh
        return () => {
            runtime.agents.off('change', onChange);
            clearInterval(clock);
            clearTimeout(timer);
        };
    }, []);
}
export const agentGlyph = (a) => runtime.agents.isActive(a) ? { g: '●', color: 'yellow' } : a.status === 'done' ? { g: '✓', color: 'green' } : a.status === 'cancelled' ? { g: '■', color: 'gray' } : { g: '✗', color: 'red' };
/** `/agents`: every subagent this conversation spawned (finished ones too); click one to view it. */
export function AgentsWindow({ width, onOpen, onClose }) {
    useAgentsTick();
    const agents = runtime.agents.list().sort((a, b) => Number(runtime.agents.isActive(b)) - Number(runtime.agents.isActive(a)) || b.id - a.id);
    const [cursor, setCursor] = useState(0);
    useInput((input, key) => {
        if (key.escape || input === 'q')
            onClose();
        else if (key.upArrow)
            setCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow)
            setCursor((c) => Math.min(agents.length - 1, c + 1));
        else if (key.return && agents[cursor])
            onOpen(agents[cursor].id);
        else if (input === 'k' && agents[cursor])
            runtime.agents.cancel(agents[cursor].id);
    });
    return (_jsx(Window, { title: "Subagents", width: width, onClose: onClose, footer: "click/enter view & message \u00B7 k stop \u00B7 esc close", children: _jsx(Box, { flexDirection: "column", marginY: 1, children: agents.map((a, i) => {
                const g = agentGlyph(a);
                return (_jsx(Clickable, { onHover: () => setCursor(i), onClick: () => onOpen(a.id), children: _jsxs(Text, { wrap: "truncate", color: i === cursor ? 'cyan' : undefined, children: [i === cursor ? '❯ ' : '  ', _jsxs(Text, { color: g.color, children: [g.g, " "] }), _jsxs(Text, { dimColor: true, children: ["#", String(a.id).padEnd(3)] }), a.name.padEnd(16), _jsx(Text, { dimColor: true, children: `${a.modelLabel ?? a.requested} · ${a.mode}`.padEnd(22) }), _jsx(Text, { dimColor: true, children: subagentStatusText(a).padEnd(20) }), a.task.replace(/\s+/g, ' ')] }) }, a.id));
            }) }) }));
}
