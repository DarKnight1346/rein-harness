import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { age } from './format.js';
import { Clickable } from './terminal/clicks.js';
const ROWS = 10;
const MODES = [
    ['both', 'Restore code and conversation', 'files back to before this message; the conversation ends just before it'],
    ['conversation', 'Restore conversation only', 'files stay as they are now'],
    ['code', 'Restore code only', 'the conversation stays; files go back to before this message'],
];
/**
 * /rewind (or esc twice): pick one of your messages (newest first), then what to restore. The
 * message's text goes back into the input so it can be edited and resent.
 */
export function RewindScreen({ points, onPick, onCancel }) {
    const [cursor, setCursor] = useState(0);
    const [chosen, setChosen] = useState();
    const [mode, setMode] = useState(0);
    const modes = chosen && chosen.files === 0 && !chosen.whole ? MODES.filter(([m]) => m === 'conversation') : MODES;
    useInput((input, key) => {
        if (key.escape || input === 'q')
            return chosen ? setChosen(undefined) : onCancel();
        if (!chosen) {
            if (key.upArrow)
                setCursor((c) => Math.max(0, c - 1));
            else if (key.downArrow)
                setCursor((c) => Math.min(points.length - 1, c + 1));
            else if (key.return && points[cursor]) {
                setChosen(points[cursor]);
                setMode(0);
            }
        }
        else if (key.upArrow)
            setMode((m) => Math.max(0, m - 1));
        else if (key.downArrow)
            setMode((m) => Math.min(modes.length - 1, m + 1));
        else if (key.return)
            onPick(chosen.index, modes[mode][0]);
    });
    if (!points.length) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: "Nothing to rewind yet." }), _jsx(Text, { dimColor: true, children: "esc close" })] }));
    }
    if (chosen) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { wrap: "truncate", children: ["Rewind to before: ", _jsx(Text, { bold: true, children: chosen.text.replace(/\s+/g, ' ').slice(0, 80) })] }), _jsx(Text, { dimColor: true, children: chosen.whole
                        ? 'Restores every file changed since — including changes made by shell commands (files ignored by .gitignore are left alone).'
                        : chosen.files
                            ? `${chosen.files} file${chosen.files === 1 ? '' : 's'} changed since by Rein's tools (shell changes weren't snapshotted for this message)`
                            : 'No file changes since by Rein’s tools' }), _jsx(Box, { flexDirection: "column", marginY: 1, children: modes.map(([m, label, hint], i) => (_jsx(Clickable, { onHover: () => setMode(i), onClick: () => onPick(chosen.index, m), children: _jsxs(Text, { color: i === mode ? 'cyan' : undefined, children: [i === mode ? '❯ ' : '  ', label, _jsxs(Text, { dimColor: true, children: [" \u2014 ", hint] })] }) }, m))) }), _jsx(Text, { dimColor: true, children: "enter choose \u00B7 esc back" })] }));
    }
    const start = Math.max(0, Math.min(cursor - Math.floor(ROWS / 2), points.length - ROWS));
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [start > 0 && _jsxs(Text, { dimColor: true, children: ["  \u2191 ", start, " newer"] }), points.slice(start, start + ROWS).map((p, i) => {
                        const idx = start + i;
                        const on = idx === cursor;
                        return (_jsx(Clickable, { onHover: () => setCursor(idx), onClick: () => (setChosen(p), setMode(0)), children: _jsxs(Text, { wrap: "truncate", color: on ? 'cyan' : undefined, children: [on ? '❯ ' : '  ', _jsx(Text, { dimColor: !on, children: age(p.at).padEnd(9) }), _jsx(Text, { dimColor: true, children: (p.files ? `${p.files} file${p.files === 1 ? '' : 's'}` : '').padEnd(9) }), p.text.replace(/\s+/g, ' ')] }) }, p.index));
                    }), start + ROWS < points.length && _jsxs(Text, { dimColor: true, children: ["  \u2193 ", points.length - start - ROWS, " older"] })] }), _jsx(Text, { dimColor: true, children: "enter choose \u00B7 \u2191\u2193 select \u00B7 esc close \u2014 files: changed since that message" })] }));
}
