import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
/** "This project wants to run commands as hooks": shown before any project hook runs. */
export function TrustHooksPrompt({ hooks, onTrust, onSkip, bare }) {
    useInput((input, key) => {
        if (input === 'y' || input === '1')
            onTrust();
        else if (key.escape || input === 'n' || input === '2')
            onSkip();
    });
    const shown = hooks.commands.slice(0, 12);
    return (_jsxs(Box, { flexDirection: "column", ...(bare ? {} : { borderStyle: 'round', borderColor: 'yellow', paddingX: 1 }), children: [!bare && _jsx(Text, { bold: true, color: "yellow", children: "This project defines hooks" }), _jsx(Text, { children: "Its settings files run these commands automatically (on start, on prompts, around tool calls):" }), _jsxs(Box, { flexDirection: "column", marginY: 1, children: [shown.map((c, i) => (_jsxs(Text, { wrap: "truncate-end", children: ['  ', _jsx(Text, { color: "yellow", children: c.event.padEnd(17) }), c.command, _jsxs(Text, { dimColor: true, children: [" \u00B7 ", c.file] })] }, i))), hooks.commands.length > shown.length && _jsxs(Text, { dimColor: true, children: ["  \u2026 and ", hooks.commands.length - shown.length, " more"] })] }), _jsx(Text, { dimColor: true, children: "They run with your permissions. Only trust hooks from people you trust; any change to them asks again." }), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsxs(Text, { children: [_jsx(Text, { color: "yellow", children: "1" }), " Trust these hooks and run them ", _jsx(Text, { dimColor: true, children: "(y)" })] }), _jsxs(Text, { children: [_jsx(Text, { color: "yellow", children: "2" }), " Don't run them ", _jsx(Text, { dimColor: true, children: "(n / esc \u00B7 you'll be asked again next time)" })] })] })] }));
}
