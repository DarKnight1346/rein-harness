import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { Clickable } from './terminal/clicks.js';
import { redact } from './privacy.js';
const MAX_PREVIEW_LINES = 14;
/**
 * Ask before a file change or shell command runs. 1/y = allow once, 2/a = allow for the rest of
 * this session, 3 = always allow calls like this (saves a rule to .rein/settings.json),
 * n/4/esc = deny (the model is told to ask how to proceed).
 */
export function ApprovalPrompt({ req, onDecide, bare }) {
    useInput((input, key) => {
        if (input === '1' || input === 'y' || key.return)
            onDecide('once');
        else if ((input === '2' || input === 'a') && !req.sensitive && !req.planMode)
            onDecide('session');
        else if (input === '3' && req.suggestion && !req.planMode)
            onDecide('always');
        else if (input === '4' || input === 'n' || key.escape)
            onDecide('deny');
    });
    const lines = req.preview ? req.preview.split('\n') : [];
    const shown = lines.slice(0, MAX_PREVIEW_LINES);
    const outside = req.outside?.length ? req.outside : undefined;
    // Outside the project: "this session" means reads anywhere, or this folder for changes.
    // Credentials/secrets only ever get a one-time yes.
    const sessionLabel = req.sessionLabel
        ? `2 ${req.sessionLabel}`
        : outside
            ? req.tool.mutating
                ? `2 Allow ${outside.length === 1 ? 'this folder' : 'these folders'} this session`
                : '2 Allow reads outside the project this session'
            : '2 Allow all changes & commands this session';
    const options = [
        ['once', '1 Allow'],
        ...(req.sensitive || req.planMode ? [] : [['session', sessionLabel]]),
        ...(req.suggestion ? [['always', `3 Always allow ${req.suggestion} (this project)`]] : []),
        ['deny', '4 Deny'],
    ];
    return (_jsxs(Box, { flexDirection: "column", ...(bare ? {} : { borderStyle: 'round', borderColor: 'yellow', paddingX: 1 }), children: [_jsxs(Text, { children: [req.origin ? _jsxs(Text, { color: "magenta", children: ["Subagent ", req.origin.name] }) : 'Rein', " wants to ", _jsx(Text, { bold: true, color: "yellow", children: req.tool.label }), " ", _jsx(Text, { bold: true, children: redact(req.summary) })] }), req.planMode ? _jsx(Text, { color: "yellow", children: "\u23F8 Plan mode: this command isn't known to be read-only \u2014 allow it only if it just looks things up." }) : null, outside ? (_jsxs(Text, { color: req.sensitive ? 'red' : 'yellow', children: [req.sensitive ? '⚠ Sensitive location (credentials/secrets) outside the project: ' : 'Outside the project: ', outside.map((p) => redact(p)).join(', ')] })) : null, shown.length ? (_jsxs(Box, { flexDirection: "column", marginY: 1, children: [shown.map((l, i) => (_jsx(Text, { wrap: "truncate", color: l.startsWith('+ ') ? 'green' : l.startsWith('- ') ? 'red' : /^(background )?\$ /.test(l) ? 'yellow' : undefined, dimColor: !/^([+-] |(background )?\$ )/.test(l), children: redact(l) || ' ' }, i))), lines.length > shown.length && _jsxs(Text, { dimColor: true, children: ["\u2026 ", lines.length - shown.length, " more lines"] })] })) : (_jsx(Text, { children: " " })), _jsx(Box, { children: options.map(([d, label]) => (_jsx(Box, { marginRight: 2, children: _jsx(Clickable, { onClick: () => onDecide(d), children: _jsxs(Text, { color: d === 'deny' ? 'red' : d === 'once' ? 'green' : 'cyan', children: ["[", label, "]"] }) }) }, d))) }), _jsx(Text, { dimColor: true, children: req.sensitive ? 'enter/1 allow once · esc/4 deny' : `enter/1 allow · 2 allow session${req.suggestion ? ' · 3 always' : ''} · esc/4 deny` })] }));
}
