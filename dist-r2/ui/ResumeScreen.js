import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { age } from './format.js';
import { Clickable } from './terminal/clicks.js';
const ROWS = 12;
/** Pick a saved conversation to continue (newest first). Esc starts a new one. */
export function ResumeScreen({ sessions, onPick, onCancel, bare }) {
    const [cursor, setCursor] = useState(0);
    useInput((input, key) => {
        if (key.escape || input === 'q')
            onCancel();
        else if (key.upArrow)
            setCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow)
            setCursor((c) => Math.min(sessions.length - 1, c + 1));
        else if (key.pageUp)
            setCursor((c) => Math.max(0, c - ROWS));
        else if (key.pageDown)
            setCursor((c) => Math.min(sessions.length - 1, c + ROWS));
        else if (key.return && sessions[cursor])
            onPick(sessions[cursor].id);
    });
    const start = Math.max(0, Math.min(cursor - Math.floor(ROWS / 2), sessions.length - ROWS));
    const visible = sessions.slice(start, start + ROWS);
    const wheel = (dir) => setCursor((c) => Math.max(0, Math.min(sessions.length - 1, c + dir)));
    return (_jsxs(Box, { flexDirection: "column", ...(bare ? {} : { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 }), children: [!bare && _jsx(Text, { bold: true, children: "Continue a conversation" }), _jsxs(Box, { flexDirection: "column", marginY: 1, children: [start > 0 && _jsxs(Text, { dimColor: true, children: ["  \u2191 ", start, " newer"] }), visible.map((s, i) => {
                        const idx = start + i;
                        const on = idx === cursor;
                        return (_jsx(Clickable, { onHover: () => setCursor(idx), onClick: () => onPick(s.id), onWheel: wheel, children: _jsxs(Text, { wrap: "truncate", color: on ? 'cyan' : undefined, children: [on ? '❯ ' : '  ', _jsx(Text, { dimColor: !on, children: age(s.updatedAt).padEnd(9) }), _jsx(Text, { dimColor: true, children: `${s.messages} msgs`.padEnd(9) }), s.title, _jsxs(Text, { dimColor: true, children: ['  ', s.models.join(', '), s.summarized ? ' · summarized' : ''] })] }) }, s.id));
                    }), start + ROWS < sessions.length && _jsxs(Text, { dimColor: true, children: ["  \u2193 ", sessions.length - start - ROWS, " older"] })] }), _jsx(Text, { dimColor: true, children: "click/enter continue \u00B7 \u2191\u2193 select \u00B7 esc start a new conversation" })] }));
}
