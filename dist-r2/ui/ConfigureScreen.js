import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TabBar } from './TabBar.js';
import { runtime } from '../runtime.js';
import { DEFAULT_SIDEBAR, DEFAULT_STATUS, enabledItems, SIDEBAR_ITEMS, STATUS_ITEMS } from './layout.js';
import { Clickable } from './terminal/clicks.js';
const TABS = [
    { id: 'status', title: 'Status line', items: STATUS_ITEMS, defaults: DEFAULT_STATUS, key: 'statusLine' },
    { id: 'sidebar', title: 'Sidebar', items: SIDEBAR_ITEMS, defaults: DEFAULT_SIDEBAR, key: 'sidebarSections' },
];
const CHOICE_TABS = [
    {
        title: 'Approvals',
        key: 'toolApproval',
        description: 'What happens when the agent wants to write, edit or delete a file. Reads and searches never ask.',
        choices: [
            { value: 'ask', label: 'Ask — confirm every file change  (default)' },
            { value: 'auto', label: 'Auto — the decision model approves changes that clearly match your request; asks you otherwise' },
            { value: 'bypass', label: 'Bypass — allow every file change without asking' },
        ],
    },
    {
        title: 'Sandbox',
        key: 'sandbox',
        description: "An OS sandbox around the agent's shell commands (macOS sandbox-exec, Linux bubblewrap). Your own ! commands, hooks and MCP servers aren't sandboxed.",
        choices: [
            { value: 'write', label: 'On — commands can only write inside the project, scratchpad, temp folders and package caches  (default)' },
            { value: 'strict', label: 'Strict — the same, and no network except localhost' },
            { value: 'off', label: 'Off — no sandbox; approvals are the only guard' },
        ],
    },
    {
        title: 'Shell',
        key: 'shellMaxMinutes',
        description: 'Longest a foreground command may run. The agent picks a timeout per command (2 min by default) up to this cap. Background processes have no limit.',
        choices: [10, 30, 60, 120, 240, 480, 0].map((v) => ({
            value: v,
            label: v === 0 ? 'No limit' : `${v < 60 ? `${v} minutes` : `${v / 60} hour${v === 60 ? '' : 's'}`}${v === 120 ? '  (default)' : ''}`,
        })),
    },
    {
        title: 'Subagents',
        key: 'subagentLimit',
        description: 'How many subagents may run at once (the agent is told the limit and waits or does the work itself when it is reached).',
        choices: [1, 2, 3, 5, 10, 20].map((v) => ({ value: v, label: `${v} at a time${v === 10 ? '  (default)' : ''}` })),
    },
    {
        title: 'Goals',
        key: 'goalMaxRounds',
        description: 'How many automatic continuations a /goal may take before it pauses itself (/goal resume continues).',
        choices: [0, 10, 25, 50, 100, 250].map((v) => ({ value: v, label: v === 0 ? 'Unlimited  (default)' : `${v} continuations` })),
    },
    {
        title: 'Load balancing',
        key: 'loadBalancing',
        description: 'How Rein spreads work across your subscriptions. Balanced moves a conversation to the account with the most room only when its prompt cache has gone cold (idle 5+ min) or the account is near its limit; new chats and subagents start on the least-used account.',
        choices: [
            { value: 'balanced', label: 'Balanced  (default) — cache-aware' },
            { value: 'sticky', label: 'Sticky — stay on one account until it hits a limit' },
        ],
    },
    {
        title: 'Notifications',
        key: 'notifications',
        description: 'Get your attention when Rein needs you (an approval, a question, a plan to review) or finishes a task that took a while.',
        choices: [
            { value: 'terminal', label: 'Terminal — bell + terminal notification (iTerm2, WezTerm, kitty, Ghostty…)  (default)' },
            { value: 'system', label: 'Desktop — also a macOS / Linux desktop notification' },
            { value: 'off', label: 'Off' },
        ],
    },
    {
        title: 'Paste',
        key: 'collapsePastes',
        description: 'Big pastes (more than 3 lines or 800 characters) can show in the input as a short placeholder, sent in full with your message, or go in as plain text you can edit.',
        choices: [
            { value: true, label: 'Placeholder — [Pasted text #1 +40 lines]  (default)' },
            { value: false, label: 'Plain text — paste it into the input as-is' },
        ],
    },
    {
        title: 'Limits',
        key: 'waitForLimits',
        description: 'When every account for the model is at its usage limit (and no other model can take over), Rein can wait for the earliest reset and carry on by itself: a goal left running overnight keeps going. Waits of more than 12 hours (a weekly limit) are not waited for. Esc stops a wait.',
        choices: [
            { value: true, label: 'Wait for the reset and continue  (default)' },
            { value: false, label: 'Stop and tell me' },
        ],
    },
    {
        title: 'Attribution',
        key: 'attribution',
        description: 'Commits and pull requests the agent writes end with a line crediting Rein: "Co-Authored by [Rein Harness](https://github.com/DarKnight1346/rein-harness)". Takes effect on the next turn.',
        choices: [
            { value: true, label: 'On — credit Rein in commits and PRs  (default)' },
            { value: false, label: 'Off — no attribution line' },
        ],
    },
    {
        title: 'Worktrees',
        key: 'worktrees',
        description: "Subagents working at the same time as other work get their own copy of the project (a git worktree), so they can't trip over each other. Their changes merge back on their own when they finish; you never manage a worktree.",
        choices: [
            { value: 'auto', label: 'Automatic — only when subagents work in parallel  (default)' },
            { value: 'off', label: 'Off — subagents always edit the project directly' },
        ],
    },
    {
        title: 'API accounts',
        key: 'apiAccounts',
        description: 'When Rein uses pay-per-use API accounts (Anthropic Console, Bedrock, Vertex, OpenAI keys) added in /login. Subscriptions always come first.',
        choices: [
            { value: 'fallback', label: 'Fallback — only when no subscription can serve the model  (default)' },
            { value: 'always', label: 'Always — alongside subscriptions (after them)' },
        ],
    },
    {
        title: 'Updates',
        key: 'autoUpdate',
        description: 'On launch, check npm for a newer Rein and install it in the background (takes effect next start). /update or rein --update also updates the claude and codex CLIs.',
        choices: [
            { value: true, label: 'Auto-update Rein  (default)' },
            { value: false, label: 'Only when I run /update' },
        ],
    },
    {
        title: 'Privacy',
        key: 'hidePersonalInfo',
        description: 'Hide your emails and username in the UI so screenshots are safe to share. Accounts show as "Claude Account 1", "Codex Account 1"; your home folder shows as ~.',
        choices: [
            { value: true, label: 'Hide personal info  (default)' },
            { value: false, label: 'Show emails and paths' },
        ],
    },
    {
        title: 'Compaction',
        key: 'autoCompactPct',
        description: "Summarize the conversation automatically when the context reaches this share of the model's window — mid-turn too: the agent keeps working from the summary.",
        choices: [0, 50, 60, 70, 80, 90, 95].map((v) => ({
            value: v,
            label: v === 0 ? 'Off (only /compact, or when a model rejects a full context)' : `At ${v}% of the context window${v === 80 ? '  (default)' : ''}`,
        })),
    },
];
const TAB_TITLES = [...TABS.map((t) => t.title), ...CHOICE_TABS.map((t) => t.title)];
/**
 * `/settings`: choose and order what the status line and sidebar show. Changes save immediately
 * and apply live (the bar and sidebar behind the window update as you toggle).
 */
export function ConfigureScreen({ onClose, onChange, bare }) {
    const [tabIndex, setTabIndex] = useState(0);
    const [cursor, setCursor] = useState(0);
    const switchTab = (i) => {
        setTabIndex((i + TAB_TITLES.length) % TAB_TITLES.length);
        setCursor(0);
    };
    const tabs = _jsx(TabBar, { titles: TAB_TITLES, active: tabIndex, onSelect: switchTab });
    const frame = bare ? {} : { borderStyle: 'round', borderColor: 'cyan', paddingX: 1 };
    if (tabIndex >= TABS.length) {
        const def = CHOICE_TABS[tabIndex - TABS.length];
        return _jsx(ChoiceTab, { def: def, tabs: tabs, frame: frame, onClose: onClose, onChange: onChange, switchTab: (d) => switchTab(tabIndex + d) }, def.key);
    }
    return _jsx(LayoutTab, { tab: TABS[tabIndex], tabs: tabs, frame: frame, cursor: cursor, setCursor: setCursor, onClose: onClose, onChange: onChange, switchTab: (d) => switchTab(tabIndex + d) });
}
/** Single-choice setting (approvals, auto-compact threshold). */
function ChoiceTab({ def, tabs, frame, onClose, onChange, switchTab }) {
    const current = runtime.config[def.key];
    const [cursor, setCursor] = useState(Math.max(0, def.choices.findIndex((c) => c.value === current)));
    const choose = (i) => {
        const c = def.choices[i];
        if (c)
            void runtime.setConfig({ [def.key]: c.value }).then(onChange);
    };
    useInput((input, key) => {
        if (key.escape || input === 'q')
            onClose();
        else if (key.tab || key.rightArrow)
            switchTab(1);
        else if (key.leftArrow)
            switchTab(-1);
        else if (key.upArrow)
            setCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow)
            setCursor((c) => Math.min(def.choices.length - 1, c + 1));
        else if (key.return || input === ' ')
            choose(cursor);
    });
    return (_jsxs(Box, { flexDirection: "column", ...frame, children: [tabs, _jsx(Text, { dimColor: true, children: def.description }), _jsx(Box, { flexDirection: "column", marginY: 1, children: def.choices.map((c, i) => (_jsx(Clickable, { onHover: () => setCursor(i), onClick: () => choose(i), children: _jsxs(Text, { color: i === cursor ? 'cyan' : undefined, wrap: "truncate", children: [i === cursor ? '❯ ' : '  ', c.value === current ? '● ' : '○ ', c.label] }) }, String(c.value)))) }), _jsx(Text, { dimColor: true, children: "click/enter choose \u00B7 \u2190\u2192 tab \u00B7 esc close" })] }));
}
function LayoutTab({ tab, tabs, frame, cursor, setCursor, onClose, onChange, switchTab }) {
    const enabled = enabledItems(tab.id, runtime.config);
    // Enabled items first (in their order), then the rest (in default order).
    const rows = [...enabled.map((id) => tab.items.find((i) => i.id === id)), ...tab.items.filter((i) => !enabled.includes(i.id))];
    const save = (next, keepCursorOn) => {
        void runtime.setConfig({ [tab.key]: next }).then(() => {
            onChange();
            if (keepCursorOn) {
                const order = [...next, ...tab.items.map((i) => i.id).filter((id) => !next.includes(id))];
                setCursor(Math.max(0, order.indexOf(keepCursorOn)));
            }
        });
    };
    const toggle = (idx) => {
        const item = rows[idx];
        if (!item)
            return;
        save(enabled.includes(item.id) ? enabled.filter((id) => id !== item.id) : [...enabled, item.id], item.id);
    };
    const move = (idx, dir) => {
        const item = rows[idx];
        const at = item ? enabled.indexOf(item.id) : -1;
        const to = at + dir;
        if (at < 0 || to < 0 || to >= enabled.length)
            return;
        const next = [...enabled];
        [next[at], next[to]] = [next[to], next[at]];
        save(next, item.id);
    };
    useInput((input, key) => {
        if (key.escape || input === 'q')
            onClose();
        else if (key.tab || key.rightArrow)
            switchTab(1);
        else if (key.leftArrow)
            switchTab(-1);
        else if (key.upArrow && key.shift)
            move(cursor, -1);
        else if (key.downArrow && key.shift)
            move(cursor, 1);
        else if (input === '[')
            move(cursor, -1);
        else if (input === ']')
            move(cursor, 1);
        else if (key.upArrow)
            setCursor((c) => Math.max(0, c - 1));
        else if (key.downArrow)
            setCursor((c) => Math.min(rows.length - 1, c + 1));
        else if (key.return || input === ' ')
            toggle(cursor);
        else if (input === 'r')
            save(tab.defaults);
    });
    return (_jsxs(Box, { flexDirection: "column", ...frame, children: [tabs, _jsx(Text, { dimColor: true, children: tab.id === 'status' ? 'Segments of the top status line, left to right.' : 'Sidebar sections, top to bottom (fullscreen).' }), _jsx(Box, { flexDirection: "column", marginY: 1, children: rows.map((item, i) => {
                    const on = enabled.includes(item.id);
                    const pos = enabled.indexOf(item.id);
                    return (_jsxs(Box, { children: [_jsx(Clickable, { onHover: () => setCursor(i), onClick: () => toggle(i), children: _jsxs(Text, { color: i === cursor ? 'cyan' : undefined, dimColor: !on && i !== cursor, wrap: "truncate", children: [i === cursor ? '❯ ' : '  ', on ? '[✓] ' : '[ ] ', item.label.padEnd(16), _jsx(Text, { dimColor: true, children: item.description })] }) }), on ? (_jsxs(_Fragment, { children: [_jsx(Box, { flexGrow: 1 }), _jsx(Clickable, { onClick: () => move(i, -1), children: _jsx(Text, { dimColor: pos === 0, color: pos === 0 ? undefined : 'gray', children: " \u25B2" }) }), _jsx(Clickable, { onClick: () => move(i, 1), children: _jsx(Text, { dimColor: pos === enabled.length - 1, color: pos === enabled.length - 1 ? undefined : 'gray', children: " \u25BC" }) })] })) : null] }, item.id));
                }) }), _jsx(Text, { dimColor: true, children: "click/space toggle \u00B7 \u25B2\u25BC or shift+\u2191\u2193 / [ ] reorder \u00B7 r reset \u00B7 \u2190\u2192 tab \u00B7 esc close" })] }));
}
