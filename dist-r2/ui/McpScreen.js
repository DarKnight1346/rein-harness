import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { approveProjectServer } from '../mcp/config.js';
import { runtime } from '../runtime.js';
import { Clickable } from './terminal/clicks.js';
const COLOR = { connected: 'green', connecting: 'yellow', failed: 'red', 'needs-approval': 'yellow', 'needs-auth': 'yellow' };
const SOURCE = { project: '.mcp.json', rein: '~/.rein/mcp.json', claude: '~/.claude.json', plugin: 'plugin' };
/** /mcp: servers with status and tool count; enter approves a project server or reconnects. */
export function McpScreen({ onClose }) {
    const [, setTick] = useState(0);
    const [cursor, setCursor] = useState(0);
    const [busy, setBusy] = useState();
    /** Sign-in in progress: the authorization URL (in case the browser didn't open), or an error. */
    const [signIn, setSignIn] = useState();
    useEffect(() => {
        const on = () => setTick((t) => t + 1);
        runtime.mcp.on('change', on);
        return () => void runtime.mcp.off('change', on);
    }, []);
    const servers = runtime.mcp.list();
    const act = async (i) => {
        const s = servers[i];
        if (!s || busy)
            return;
        setBusy(s.name);
        if (s.status === 'needs-approval') {
            approveProjectServer(process.cwd(), s.name);
            await runtime.mcp.start();
        }
        else if (s.status === 'needs-auth') {
            setSignIn({ name: s.name });
            try {
                await runtime.mcp.signIn(s.name, (url) => setSignIn({ name: s.name, url }));
                setSignIn(undefined);
            }
            catch (err) {
                setSignIn({ name: s.name, error: err.message });
            }
        }
        else
            await runtime.mcp.reconnect(s.name);
        setBusy(undefined);
    };
    useInput((input, key) => {
        if (key.escape || input === 'q')
            onClose();
        else if (key.upArrow)
            setCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow)
            setCursor((c) => Math.min(servers.length - 1, c + 1));
        else if (key.return)
            void act(cursor);
    });
    if (!servers.length) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: "No MCP servers configured." }), _jsxs(Text, { dimColor: true, children: ["Add them to .mcp.json in the project, ~/.rein/mcp.json, or with `claude mcp add` (Claude Code's format: ", '{"mcpServers": {"name": {"command": "…", "args": []}}}', ")."] }), _jsx(Text, { dimColor: true, children: "esc close" })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", children: [servers.map((s, i) => (_jsx(Clickable, { onHover: () => setCursor(i), onClick: () => void act(i), children: _jsxs(Text, { wrap: "truncate", color: i === cursor ? 'cyan' : undefined, children: [i === cursor ? '❯ ' : '  ', _jsx(Text, { color: COLOR[s.status], children: "\u25CF" }), " ", _jsx(Text, { bold: true, children: s.name.padEnd(16) }), busy === s.name ? (s.status === 'needs-auth' ? 'waiting for the browser sign-in…' : 'working…') : s.status === 'needs-auth' ? 'sign in' : s.status === 'connected' ? `${s.tools} tool${s.tools === 1 ? '' : 's'}` : s.status, _jsxs(Text, { dimColor: true, children: [' ', "\u00B7 ", s.transport, " \u00B7 ", SOURCE[s.source] ?? s.source, s.error ? ` · ${s.error.slice(0, 80)}` : ''] })] }) }, s.name))), signIn && (_jsx(Box, { marginTop: 1, flexDirection: "column", children: signIn.error ? (_jsxs(Text, { color: "red", children: ["Sign-in to ", signIn.name, " failed: ", signIn.error] })) : (_jsxs(_Fragment, { children: [_jsxs(Text, { color: "yellow", children: ["Sign in to ", signIn.name, " in your browser (it should have opened)."] }), signIn.url && _jsxs(Text, { dimColor: true, wrap: "truncate-end", children: ["If it didn't: ", signIn.url] })] })) })), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { dimColor: true, children: ["enter: ", servers[cursor]?.status === 'needs-approval' ? 'approve this project server (runs its command)' : servers[cursor]?.status === 'needs-auth' ? 'sign in (opens your browser)' : 'reconnect', " \u00B7 esc close"] }) })] }));
}
