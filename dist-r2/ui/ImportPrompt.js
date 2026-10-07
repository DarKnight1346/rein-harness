import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { accountName, hidingIdentity } from './privacy.js';
import { PROVIDERS } from '../providers/types.js';
export function ImportPrompt({ rows, onImport, onSkip, bare }) {
    useInput((input, key) => {
        if (key.return || input === 'y')
            onImport();
        else if (key.escape || input === 'n')
            onSkip();
    });
    return (_jsxs(Box, { flexDirection: "column", ...(bare ? {} : { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 }), children: [!bare && _jsx(Text, { bold: true, children: "Found existing logins" }), _jsx(Box, { flexDirection: "column", marginY: 1, children: rows.map(({ account, status }) => (_jsxs(Text, { children: ['  ', _jsx(Text, { bold: true, children: PROVIDERS[account.provider].name.padEnd(7) }), status.loggedIn ? (hidingIdentity() ? accountName(account, rows.map((r) => r.account)) : (status.email ?? 'unknown email')) : '', status.loggedIn && status.plan ? _jsxs(Text, { dimColor: true, children: [" \u00B7 ", status.plan] }) : null] }, account.id))) }), _jsx(Text, { dimColor: true, children: "Rein uses them in place (nothing is copied) and never logs them out." }), _jsx(Text, { children: "Import? (Y/n)" })] }));
}
