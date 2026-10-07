import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
/** Matches for `query`, newest first: every word must appear (case-insensitive). */
export function searchHistory(entries, query, limit = 12) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
        const e = entries[i];
        const low = e.toLowerCase();
        if (words.every((w) => low.includes(w)) && !out.includes(e))
            out.push(e);
    }
    return out;
}
/**
 * Ctrl+R: search the messages you sent in this project (newest first). Type to filter, ↑/↓ or
 * Ctrl+R again to move, Enter puts the message in the input, Esc cancels.
 */
export function HistorySearch({ entries, onPick, onCancel, width = 80 }) {
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);
    const matches = searchHistory(entries, query);
    const pick = Math.min(index, Math.max(0, matches.length - 1));
    useInput((input, key) => {
        if (key.upArrow || (key.ctrl && input === 'r'))
            setIndex((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
        else if (key.downArrow)
            setIndex((i) => Math.max(0, i - 1));
    });
    const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: "search: " }), _jsx(TextInput, { value: query, onChange: (q) => {
                            setQuery(q);
                            setIndex(0);
                        }, onSubmit: () => (matches[pick] !== undefined ? onPick(matches[pick]) : onCancel()), onCancel: onCancel, placeholder: "type to search your earlier messages" })] }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: matches.length ? (matches.map((m, i) => (_jsxs(Text, { wrap: "truncate-end", color: i === pick ? 'cyan' : undefined, children: [i === pick ? '❯ ' : '  ', oneLine(m).slice(0, width)] }, i)))) : (_jsx(Text, { dimColor: true, children: entries.length ? 'No earlier message matches.' : 'No messages sent in this project yet.' })) }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "enter: put it in the input \u00B7 \u2191\u2193 / ctrl+r: move \u00B7 esc: cancel" }) })] }));
}
