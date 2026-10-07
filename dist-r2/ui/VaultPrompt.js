import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from 'ink';
import { TextInput } from './TextInput.js';
/** `/vault set NAME`: the value is typed here, hidden, and goes straight into the vault (never the chat). */
export function VaultPrompt({ secret, onSave, onCancel }) {
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { dimColor: true, children: ["The agent can use it as $", secret, " in shell commands, but never sees the value. Esc cancels."] }), _jsxs(Box, { marginTop: 1, children: [_jsxs(Text, { children: [secret, ": "] }), _jsx(TextInput, { mask: true, placeholder: "paste or type the value", onSubmit: (v) => (v ? onSave(v) : onCancel()), onCancel: onCancel })] })] }));
}
