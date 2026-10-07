import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { VaultPrompt } from '../VaultPrompt.js';
import { needsBidi, visualOrder } from '../bidi.js';
import { voiceNote } from '../useRein.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useBoxMetrics, useInput, useWindowSize } from 'ink';
import { PROVIDERS, parseRef, refKey } from '../../providers/types.js';
import { runtime } from '../../runtime.js';
import { catalog, toRef } from '../../router/catalog.js';
import { defaultRef } from '../../router/index.js';
import { usageStore, windowLabel } from '../../store/usage.js';
import { accountLabel } from '../format.js';
import { ImportPrompt } from '../ImportPrompt.js';
import { TrustHooksPrompt } from '../TrustHooksPrompt.js';
import { HistorySearch } from '../HistorySearch.js';
import { LoginScreen } from '../LoginScreen.js';
import { ModelScreen } from '../ModelScreen.js';
import { Clickable, useClickable } from '../terminal/clicks.js';
import { TextInput, wrapInput } from '../TextInput.js';
import { goalSummary, useRein } from '../useRein.js';
import { RewindScreen } from '../RewindScreen.js';
import { McpScreen } from '../McpScreen.js';
import { PlanScreen } from '../PlanScreen.js';
import { AskScreen } from '../AskScreen.js';
import { renderMarkdown } from '../markdown.js';
import { progress } from '../../plans/store.js';
import { PlansScreen } from '../PlansScreen.js';
import { isMilestoneCopy, todoLine } from '../../tools/todo.js';
import { Splash, splashHeight } from './SplashScreen.js';
import { hidingIdentity, redact } from '../privacy.js';
import { contextPct, enabledItems, statusInfo } from '../layout.js';
import { ConfigureScreen } from '../ConfigureScreen.js';
import { ApprovalPrompt } from '../ApprovalPrompt.js';
import { ResumeScreen } from '../ResumeScreen.js';
import { LiveShell, ShellsWindow, ShellWindow, useShellsTick } from './Shells.js';
import { AgentsWindow, agentGlyph, useAgentsTick } from './Agents.js';
import { subagentStatusText } from '../../agents/manager.js';
import { kTokens, rainbow, Working } from '../Working.js';
import { agentLines, assistantLines, entryLines, wrap } from './lines.js';
import { InfoWindow, Window } from './Window.js';
import { COMMANDS } from '../../commands/index.js';
import { skillDirs, skillSourceLabel } from '../../skills/index.js';
import chalk from 'chalk';
import { isEmpty, lineRange, selectedText } from './selection.js';
import { copyToClipboard } from '../terminal/clipboard.js';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import cliTruncate from 'cli-truncate';
const SIDEBAR_WIDTH = 32;
const SIDEBAR_MIN_COLS = 96;
const MAX_INPUT_LINES = 6;
/** Windows with tabs keep one size whichever tab is showing (capped to the terminal). */
const TABBED_HEIGHT = 30;
/** Latest transcript entries, printed to the normal screen when fullscreen exits. */
export const lastEntries = { current: [] };
/**
 * Fullscreen renderer (alt screen): top bar · history (virtualized, scrollable) + sidebar · activity
 * line · input · footer. The root is exactly the terminal size, so Ink never overflows into a full
 * clear and resizes redraw cleanly.
 */
export function FullscreenApp({ resume }) {
    const { columns: cols, rows } = useWindowSize();
    const r = useRein({ resume, renderer: 'fullscreen', onClear: () => setScroll(0) });
    const { chat, overlay } = r;
    const [sidebarOpen, setSidebarOpen] = useState(runtime.config.sidebar ?? true);
    const [scroll, setScroll] = useState(0); // lines scrolled up from the bottom
    const [selection, setSelection] = useState();
    const [flash, setFlash] = useState();
    useEffect(() => {
        if (!flash)
            return;
        const t = setTimeout(() => setFlash(undefined), 2500);
        return () => clearTimeout(t);
    }, [flash]);
    useEffect(() => {
        lastEntries.current = r.entries;
    }, [r.entries]);
    const showSidebar = sidebarOpen && cols >= SIDEBAR_MIN_COLS;
    const mainWidth = cols - (showSidebar ? SIDEBAR_WIDTH : 0);
    const textWidth = Math.max(20, mainWidth - 2);
    useAgentsTick();
    const viewing = r.viewing;
    useEffect(() => setScroll(0), [r.view]);
    // History lines, cached per entry for the current width.
    // Lines pass through redact() (hide personal info): emails → "Claude Account 1", home → ~.
    const hide = hidingIdentity();
    const cache = useRef(new Map());
    const mainLines = useMemo(() => {
        const out = [];
        for (const e of r.entries) {
            let c = cache.current.get(e.id);
            if (!c || c.width !== textWidth || c.hide !== hide) {
                c = { width: textWidth, hide, lines: entryLines(e, textWidth).map(redact) };
                cache.current.set(e.id, c);
            }
            out.push(...c.lines);
        }
        if (chat.live)
            out.push(...assistantLines(chat.live, textWidth).map(redact));
        return out;
    }, [r.entries, chat.live, textWidth, hide]);
    // Blank-state splash: fades in at launch and out once the first message is sent (and again after
    // /clear). <Splash> animates it.
    const hasUserMessage = r.entries.some((e) => e.kind === 'user');
    const [splashPhase, setSplashPhase] = useState({ fadeIn: Date.now() });
    useEffect(() => {
        if (hasUserMessage && !splashPhase.fadeOut)
            setSplashPhase((p) => ({ ...p, fadeOut: Date.now() }));
        if (!hasUserMessage && splashPhase.fadeOut)
            setSplashPhase({ fadeIn: Date.now() }); // /clear
    }, [hasUserMessage]);
    // The animation lives in <Splash> (it owns its timer and stops it itself); here only whether it may show.
    const splash = viewing ? undefined : splashPhase;
    // Viewing a subagent: its conversation replaces the main history (recomputed on its updates).
    const lines = viewing ? agentLines(viewing, textWidth).map(redact) : mainLines;
    const toggleSidebar = () => {
        const next = !sidebarOpen;
        setSidebarOpen(next);
        void runtime.setConfig({ sidebar: next });
    };
    // Keep the view anchored when scrolled up and new lines arrive.
    const prevTotal = useRef(lines.length);
    useEffect(() => {
        const delta = lines.length - prevTotal.current;
        prevTotal.current = lines.length;
        if (delta > 0)
            setScroll((s) => (s > 0 ? s + delta : 0));
    }, [lines.length]);
    // Input box: full terminal width; inside it the border (2), padding (2) and the "> " prompt (2).
    const inputWidth = Math.max(10, cols - 6);
    const draftLines = Math.min(MAX_INPUT_LINES, Math.max(1, r.draft ? wrapInput(r.draft, inputWidth).length : 1));
    const mainHeight = Math.max(3, rows - 1 /* top */ - 1 /* activity */ - (draftLines + 2) /* input */ - 1 /* footer */);
    const scrollBy = (n, viewport) => setScroll((s) => Math.max(0, Math.min(Math.max(0, lines.length - viewport), s + n)));
    useInput((input, key) => {
        if (overlay.name !== 'none')
            return;
        if (key.ctrl && input === 'b')
            toggleSidebar();
        else if (key.pageUp)
            scrollBy(Math.max(1, mainHeight - 2), mainHeight);
        else if (key.pageDown)
            scrollBy(-Math.max(1, mainHeight - 2), mainHeight);
        else if (key.end && scroll > 0)
            setScroll(0);
    });
    // Commands that show information or options open a centered window over everything; the
    // conversation keeps streaming underneath. Only autocomplete stays anchored above the input.
    const windowWidth = Math.min(100, cols - 4);
    const windowText = windowWidth - 4;
    const window = (() => {
        switch (overlay.name) {
            case 'import':
                return (_jsx(Window, { title: "Found existing logins", width: 72, onClose: () => r.finishImport(false), children: _jsx(ImportPrompt, { bare: true, rows: overlay.rows, onImport: () => r.finishImport(true), onSkip: () => r.finishImport(false) }) }));
            case 'history':
                return (_jsx(Window, { title: "Search your messages", width: windowWidth, onClose: () => r.pickHistory(undefined), children: _jsx(HistorySearch, { entries: overlay.entries, width: windowText - 2, onPick: r.pickHistory, onCancel: () => r.pickHistory(undefined) }) }));
            case 'trust':
                return (_jsx(Window, { title: "This project defines hooks", width: windowWidth, onClose: () => r.finishTrust(false), color: "yellow", dismissable: false, children: _jsx(TrustHooksPrompt, { bare: true, hooks: overlay.hooks, onTrust: () => r.finishTrust(true), onSkip: () => r.finishTrust(false) }) }));
            case 'login':
                return (_jsx(Window, { title: "Accounts", width: windowWidth, onClose: r.closeOverlay, children: _jsx(LoginScreen, { bare: true, onLog: r.log, onClose: r.closeOverlay }) }));
            case 'vault':
                return (_jsx(Window, { title: `Vault · ${overlay.secret}`, width: windowWidth, onClose: r.closeOverlay, children: _jsx(VaultPrompt, { secret: overlay.secret, onSave: (v) => r.saveVault(overlay.secret, v), onCancel: r.closeOverlay }) }));
            case 'model':
                return (_jsx(Window, { title: "Models", width: windowWidth, height: TABBED_HEIGHT, onClose: r.closeOverlay, children: _jsx(ModelScreen, { bare: true, onLog: r.log, onClose: r.closeOverlay }) }));
            case 'approval':
                return (_jsx(Window, { title: `${overlay.req.tool.name === 'shell' ? 'Approve command' : 'Approve file change'}${overlay.total > 1 ? ` (${overlay.position} of ${overlay.total})` : ''}${overlay.req.origin ? ` · subagent ${overlay.req.origin.name}` : ''}`, width: windowWidth, color: "yellow", dismissable: false, onClose: () => overlay.resolve('deny'), children: _jsx(ApprovalPrompt, { bare: true, req: overlay.req, onDecide: overlay.resolve }) }));
            case 'btw':
                return (_jsx(InfoWindow, { title: `btw · ${overlay.question.length > windowText - 10 ? overlay.question.slice(0, windowText - 11) + '…' : overlay.question}`, width: windowWidth, onClose: r.closeOverlay, lines: overlay.error
                        ? [chalk.red(overlay.error)]
                        : overlay.answer
                            ? [
                                ...renderMarkdown(overlay.answer.trim(), windowText),
                                '',
                                chalk.dim(`${overlay.model ?? 'model'} · ${overlay.mode === 'fork' ? 'forked agent' : 'from the conversation'}${overlay.done ? '' : ' · answering…'} · not added to the conversation`),
                            ]
                            : [chalk.dim('Forking the agent to answer… the main agent keeps working.')] }));
            case 'plans':
                return (_jsx(Window, { title: "Start a plan as a goal", width: windowWidth, onClose: r.closeOverlay, children: _jsx(PlansScreen, { plans: overlay.plans, onPick: r.startPlanGoal, onNew: r.startNewPlan, onCancel: r.closeOverlay }) }));
            case 'ask':
                return (_jsx(Window, { title: "Questions from the agent", width: windowWidth, onClose: () => overlay.resolve(undefined), children: _jsx(AskScreen, { questions: overlay.questions, onDone: overlay.resolve }) }));
            case 'plan':
                return (_jsx(Window, { title: "Plan \u2014 approve to start", width: windowWidth, onClose: () => overlay.resolve('revise'), children: _jsx(PlanScreen, { plan: overlay.plan, width: windowText, onDecide: overlay.resolve }) }));
            case 'mcp':
                return (_jsx(Window, { title: "MCP servers", width: windowWidth, onClose: r.closeOverlay, children: _jsx(McpScreen, { onClose: r.closeOverlay }) }));
            case 'rewind':
                return (_jsx(Window, { title: "Rewind", width: windowWidth, onClose: r.closeOverlay, children: _jsx(RewindScreen, { points: overlay.points, onPick: (i, m) => void r.doRewind(i, m), onCancel: r.closeOverlay }) }));
            case 'resume':
                return (_jsx(Window, { title: "Continue a conversation", width: windowWidth, onClose: r.closeOverlay, children: _jsx(ResumeScreen, { bare: true, sessions: overlay.sessions, onPick: (id) => void r.pickSession(id), onCancel: r.closeOverlay }) }));
            case 'goal':
                return runtime.goals.goal ? (_jsx(InfoWindow, { title: "Goal", width: windowWidth, onClose: r.closeOverlay, lines: goalSummary(runtime.goals.goal).split('\n').flatMap((l) => wrap(l, windowText)).concat(['', chalk.dim('/goal pause · /goal resume · /goal clear')]) })) : null;
            case 'agents':
                return (_jsx(AgentsWindow, { width: windowWidth, onOpen: (id) => {
                        r.setView(id);
                        r.closeOverlay();
                    }, onClose: r.closeOverlay }));
            case 'shell':
                return _jsx(ShellWindow, { id: overlay.id, width: windowWidth, onClose: r.closeOverlay });
            case 'shells':
                return _jsx(ShellsWindow, { width: windowWidth, agent: viewing, onOpen: (id) => r.setOverlay({ name: 'shell', id }), onClose: r.closeOverlay });
            case 'settings':
                return (_jsx(Window, { title: "Configure", width: windowWidth, height: TABBED_HEIGHT, onClose: r.closeOverlay, children: _jsx(ConfigureScreen, { bare: true, onClose: r.closeOverlay, onChange: r.bump }) }));
            case 'usage':
                return (_jsx(InfoWindow, { title: "Usage", width: windowWidth, onClose: r.closeOverlay, lines: overlay.data ? entryLines({ id: -1, kind: 'usage', ...overlay.data }, windowText).slice(1) : ['Checking usage…'] }));
            case 'context':
                return (_jsx(InfoWindow, { title: overlay.agent ? `Context — subagent ${overlay.agent}` : 'Context', width: windowWidth, onClose: r.closeOverlay, lines: overlay.report ? entryLines({ id: -1, kind: 'context', report: overlay.report }, windowText).slice(1) : ['Measuring…'] }));
            case 'help':
                return _jsx(InfoWindow, { title: "Commands", width: windowWidth, onClose: r.closeOverlay, lines: helpLines(windowText, r.skills) });
            case 'update':
                return (_jsx(InfoWindow, { title: r.updating ? 'Updating…' : 'Update finished', width: windowWidth, follow: true, onClose: r.closeOverlay, lines: r.updateLog.length ? r.updateLog.flatMap((line) => entryLines({ id: -1, kind: 'update', line }, windowText)) : ['Starting…'] }));
            default:
                return null;
        }
    })();
    const panel = (() => {
        if (r.inputActive && r.suggestions.length > 0) {
            return (_jsx(Box, { flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1, children: r.suggestions.map((c, i) => (_jsx(Clickable, { onClick: () => {
                        r.onDraft('');
                        r.runCommand(`/${c.name}`);
                    }, onHover: () => r.setSuggestIndex(i), children: _jsxs(Text, { color: c === r.selected ? 'cyan' : undefined, dimColor: c !== r.selected, wrap: "truncate", children: [c === r.selected ? '❯ ' : '  ', `/${c.name}`.padEnd(10), c.description, c.skill ? _jsxs(Text, { dimColor: true, children: [" \u00B7 ", c.skill.plugin ? `plugin ${c.skill.plugin}` : skillSourceLabel(c.skill.source), c.skill.argumentHint ? ` · ${c.skill.argumentHint}` : ''] }) : null] }) }, c.name))) }));
        }
        if (r.inputActive && r.fileSuggestions.length > 0) {
            return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "gray", paddingX: 1, children: [r.fileSuggestions.map((f) => (_jsx(Clickable, { onClick: () => r.acceptFile(f), children: _jsxs(Text, { color: f === r.fileSelected ? 'cyan' : undefined, dimColor: f !== r.fileSelected, wrap: "truncate", children: [f === r.fileSelected ? '❯ ' : '  ', "@", f] }) }, f))), _jsx(Text, { dimColor: true, children: "tab/enter insert \u00B7 \u2191\u2193 select \u2014 the file's contents go with your message" })] }));
        }
        return null;
    })();
    return (_jsxs(Box, { flexDirection: "column", height: rows, children: [_jsx(TopBar, { cols: cols, tick: r.statusTick, sidebarOpen: showSidebar, onToggleSidebar: toggleSidebar, togglePlanMode: r.togglePlanMode, run: r.runCommand, openModel: () => r.setOverlay({ name: 'model' }), openShells: r.openShells, viewing: viewing, setView: r.setView }), _jsxs(Box, { flexDirection: "row", height: mainHeight, children: [_jsxs(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, height: mainHeight, overflow: "hidden", children: [_jsx(History, { width: textWidth, splash: splash, lines: lines, scroll: scroll, onScroll: (n, vp) => scrollBy(n, vp), selection: selection, onSelect: setSelection, onCopy: (text) => {
                                    void copyToClipboard(text).then((ok) => setFlash(ok ? `Copied ${text.length} characters` : 'Copy failed (no clipboard tool)'));
                                } }), panel ? _jsx(Box, { flexShrink: 0, children: panel }) : _jsx(Box, { flexShrink: 0, children: _jsx(LiveShell, { width: textWidth, agentId: viewing?.id, onOpen: (id) => r.setOverlay({ name: 'shell', id }) }) })] }), showSidebar ? _jsx(Sidebar, { width: SIDEBAR_WIDTH, height: mainHeight, tick: r.statusTick, run: r.runCommand, view: r.view, setView: r.setView }) : null] }), _jsx(Box, { height: 1, paddingLeft: 1, children: flash ? (_jsxs(Text, { color: "green", children: ["\u2713 ", flash] })) : viewing ? (runtime.agents.isActive(viewing) ? (_jsx(Working, { startedAt: viewing.startedAt, phase: "tool", tool: viewing.status === 'checking' ? 'Checking completion' : viewing.status === 'starting' ? 'Starting' : runningToolLabel(viewing) ?? `${viewing.name} working`, tokens: viewing.tokens })) : (_jsxs(Text, { dimColor: true, children: [viewing.name, " ", subagentStatusText(viewing), " \u00B7 type to message it \u00B7 ", _jsx(Text, { color: "cyan", children: "\u25C2 main" }), " in the sidebar or /agent main to go back"] }))) : chat.busy ? (_jsx(Working, { startedAt: chat.startedAt, phase: chat.phase, tool: chat.toolLabel, tokens: chat.tokens, queued: r.queued.length, waitUntil: chat.waitUntil })) : r.compacting ? (_jsx(Working, { startedAt: r.compacting.startedAt, phase: "tool", tool: r.compacting.label })) : r.goalNote ? (_jsx(Working, { startedAt: r.goalNote.startedAt, phase: "tool", tool: r.goalNote.label })) : scroll > 0 ? (_jsx(Clickable, { onClick: () => setScroll(0), children: _jsxs(Text, { color: "yellow", children: ["\u2193 ", scroll, " lines below \u00B7 End or click to jump to latest"] }) })) : (_jsx(Text, { children: " " })) }), _jsxs(Box, { borderStyle: "round", borderColor: r.inputActive ? 'cyan' : 'gray', paddingX: 1, width: cols, height: draftLines + 2, flexShrink: 0, overflow: "hidden", children: [_jsx(Text, { color: "cyan", children: '> ' }), _jsx(Box, { flexDirection: "column", width: inputWidth, justifyContent: "flex-end", overflow: "hidden", children: _jsx(TextInput, { width: inputWidth, maxLines: MAX_INPUT_LINES, isActive: r.inputActive, value: r.draft, onChange: r.onDraft, onPaste: r.onPaste, onImagePaste: r.onImagePaste, onHistory: r.onHistory, onExternalEdit: r.onExternalEdit, placeholder: !r.ready ? 'starting…' : viewing ? `message ${viewing.name} (subagent)…` : chat.busy ? 'queue a message, or /btw <question>' : 'message, / for commands', onSubmit: r.onSubmit }) })] }), _jsx(Box, { height: 1, paddingX: 1, children: r.exitArmed ? (_jsx(Text, { color: "yellow", children: "Press Ctrl+C again to exit" })) : r.voice !== 'idle' ? (_jsx(Text, { color: r.voice === 'recording' ? 'red' : 'cyan', children: voiceNote(r.voice) })) : (_jsx(Text, { dimColor: true, wrap: "truncate", children: "esc interrupt \u00B7 ctrl+c stop (twice to exit) \u00B7 wheel/PgUp scroll \u00B7 \u21E7\u21B5 / \u2325\u21B5 / \\\u21B5 newline \u00B7 ctrl+b sidebar" })) }), window] }));
}
function helpLines(width, skills) {
    const dirs = skillDirs();
    return [
        ...COMMANDS.flatMap((c) => wrap(c.description, width, chalk.cyan(`/${c.name}`.padEnd(10)))),
        '',
        chalk.bold('Skills') + chalk.dim(`  name clashes: built-in → ${dirs.project} (project) → ${dirs.global} (global)`),
        ...(skills.length
            ? skills.flatMap((s) => wrap(`${s.description} ${chalk.dim(`(${s.source})`)}`, width, chalk.magenta(`/${s.name}`.padEnd(10))))
            : [chalk.dim('  none yet — /skill:create makes one')]),
        '',
        ...wrap('esc interrupts a reply (or closes a window) · wheel / PgUp / PgDn scroll · drag to select & copy · ctrl+b sidebar · shift/option+enter or \\+enter for a new line · rein --continue picks a conversation', width).map((l) => chalk.dim(l)),
    ];
}
/**
 * Virtualized history: renders only the visible window of `lines`. Drag selects text (the
 * terminal's own selection is unavailable while mouse reporting is on); release copies it.
 * Dragging past the top/bottom edge scrolls.
 */
/** Right-to-left text in visual order where the terminal doesn't do it (display only: copying uses the text as written). */
const rtlLine = (line) => (needsBidi(process.env, runtime.config.rtl ?? 'auto') ? visualOrder(line) : line);
function History({ width, lines, scroll, onScroll, selection, onSelect, onCopy, splash }) {
    const ref = useRef(null);
    const { height } = useBoxMetrics(ref);
    const viewport = Math.max(1, height);
    const end = Math.max(0, lines.length - scroll);
    const start = Math.max(0, end - viewport);
    const visible = lines.slice(start, end);
    // Content is bottom-aligned: when there are fewer lines than rows, row 0 isn't line `start`.
    const topPad = viewport - visible.length;
    const posAt = (local) => ({
        line: Math.max(0, Math.min(lines.length - 1, start + local.y - topPad)),
        col: Math.max(0, local.x - 1), // paddingX
    });
    const sel = useRef(undefined);
    useClickable(ref, {
        onWheel: (dir) => onScroll(dir === -1 ? 3 : -3, viewport),
        onDragStart: (local) => {
            sel.current = { anchor: posAt(local), focus: posAt(local) };
            onSelect(undefined);
        },
        onDrag: (local) => {
            if (!sel.current)
                return;
            if (local.y < 0)
                onScroll(1, viewport);
            else if (local.y >= viewport)
                onScroll(-1, viewport);
            sel.current = { ...sel.current, focus: posAt(local) };
            onSelect(sel.current);
        },
        onDragEnd: (local) => {
            if (!sel.current)
                return;
            const done = { ...sel.current, focus: posAt(local) };
            sel.current = undefined;
            if (isEmpty(done))
                return onSelect(undefined); // plain click clears the selection
            onSelect(done);
            const text = selectedText(done, lines);
            if (text.trim())
                onCopy(text);
        },
    });
    // The splash sits in the empty space above the messages, vertically centered; skipped if cramped.
    const showSplash = splash && topPad >= splashHeight(width) + 2;
    return (_jsxs(Box, { ref: ref, flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "hidden", justifyContent: "flex-end", paddingX: 1, children: [showSplash ? (_jsx(Box, { flexDirection: "column", height: topPad, justifyContent: "center", flexShrink: 0, children: _jsx(Splash, { width: width, phase: splash }) })) : null, visible.map((line, i) => {
                const index = start + i;
                const plain = selection ? stripAnsi(line) : '';
                const range = selection ? lineRange(selection, index, plain.length) : undefined;
                if (!range) {
                    // Backstop: a line wider than the pane would widen the column and push the sidebar.
                    return (_jsx(Text, { wrap: "truncate", children: (stringWidth(line) > width ? cliTruncate(rtlLine(line), width) : rtlLine(line)) || ' ' }, i));
                }
                return (_jsxs(Text, { wrap: "truncate", children: [plain.slice(0, range[0]), _jsx(Text, { inverse: true, children: plain.slice(range[0], range[1]) }), plain.slice(range[1]) || ' '] }, i));
            })] }));
}
function TopBar(props) {
    useShellsTick();
    useAgentsTick();
    const background = runtime.tools.shells.running({ background: true }).filter((s) => (props.viewing ? s.origin?.agentId === props.viewing.id : !s.origin)).length;
    const activeAgents = runtime.agents.running();
    const openAgents = () => (activeAgents.length === 1 ? props.setView(activeAgents[0].id) : props.run('/agents'));
    const [, setUsageTick] = useState(0);
    useEffect(() => usageStore.subscribe(() => setUsageTick((t) => t + 1)), []);
    void props.tick;
    const info = statusInfo(props.viewing);
    const items = enabledItems('status', runtime.config);
    /** Each status segment's plain text (for fitting the bar to the terminal width). */
    const segText = (id) => {
        switch (id) {
            case 'model':
                return info.model;
            case 'account':
                return info.account;
            case 'usage':
                return info.usage || undefined;
            case 'context':
                return `ctx ${info.context}%`;
            case 'decider':
                return `decides: ${info.decider}`;
            case 'advisor':
                return `advisor: ${info.advisor}`;
            case 'approvals':
                return `edits: ${info.approvals}`;
            case 'messages':
                return `${info.messages} msgs`;
            default:
                return undefined;
        }
    };
    const segment = (id) => {
        switch (id) {
            case 'model':
                return (_jsx(Seg, { onClick: props.openModel, children: _jsx(Text, { color: "cyan", children: info.model }) }, id));
            case 'account':
                return (_jsx(Seg, { onClick: () => props.run('/usage'), children: _jsx(Text, { children: info.account }) }, id));
            case 'usage':
                return info.usage ? (_jsx(Seg, { onClick: () => props.run('/usage'), children: _jsx(Text, { dimColor: true, children: info.usage }) }, id)) : null;
            case 'context':
                return (_jsxs(Seg, { onClick: () => props.run('/context'), children: [_jsx(Text, { dimColor: true, children: "ctx " }), _jsxs(Text, { color: info.context >= 80 ? 'red' : info.context >= 50 ? 'yellow' : 'green', children: [info.context, "%"] })] }, id));
            case 'decider':
                return (_jsxs(Seg, { onClick: props.openModel, children: [_jsx(Text, { dimColor: true, children: "decides: " }), _jsx(Text, { children: info.decider })] }, id));
            case 'advisor':
                return (_jsxs(Seg, { onClick: props.openModel, children: [_jsx(Text, { dimColor: true, children: "advisor: " }), _jsx(Text, { color: info.advisor === 'off' ? 'gray' : 'magenta', children: info.advisor })] }, id));
            case 'approvals':
                return (_jsxs(Seg, { onClick: () => props.run('/settings'), children: [_jsx(Text, { dimColor: true, children: "edits: " }), _jsx(Text, { color: info.approvals === 'bypass' ? 'red' : info.approvals === 'auto' ? 'yellow' : 'green', children: info.approvals })] }, id));
            case 'messages':
                return (_jsx(Seg, { onClick: () => props.run('/context'), children: _jsxs(Text, { dimColor: true, children: [info.messages, " msgs"] }) }, id));
            default:
                return null;
        }
    };
    const parts = [];
    if (props.viewing)
        parts.push({
            key: 'viewing',
            width: 3 + `◂ main · viewing ${props.viewing.name}`.length,
            drop: 1000,
            node: (_jsxs(Seg, { onClick: () => props.setView('main'), children: [_jsx(Text, { color: "cyan", children: "\u25C2 main" }), _jsx(Text, { dimColor: true, children: " \u00B7 viewing " }), _jsx(Text, { color: "magenta", bold: true, children: props.viewing.name })] }, "viewing")),
        });
    const configured = items.filter((id) => id !== 'sidebarToggle');
    configured.forEach((id, i) => {
        const text = segText(id);
        const node = segment(id);
        if (text && node)
            parts.push({ key: id, width: 3 + stringWidth(text), drop: configured.length - i, node });
    });
    if (runtime.planMode)
        parts.push({
            key: 'plan',
            width: 3 + 11,
            drop: 900,
            node: (_jsx(Seg, { onClick: props.togglePlanMode, children: _jsx(Text, { color: "yellow", bold: true, children: "\u23F8 plan mode" }) }, "plan")),
        });
    // The connected editor, and how much is selected there (that selection goes with the next message).
    if (runtime.ide) {
        const sel = runtime.ide.selection;
        const ideText = `⧉ ${runtime.ide.lock.ideName}${sel ? ` · ${sel.endLine - sel.startLine + 1} lines` : ''}`;
        parts.push({
            key: 'ide',
            width: 3 + stringWidth(ideText),
            drop: 850,
            node: (_jsx(Seg, { onClick: () => props.run('/ide'), children: _jsx(Text, { color: "cyan", children: ideText }) }, "ide")),
        });
    }
    const goal = runtime.goals.goal;
    const goalPlan = goal?.plan ? runtime.goals.plan() : undefined;
    const goalText = goal ? `◎ goal · ${goal.status}${goalPlan ? ` · ${progress(goalPlan).done}/${progress(goalPlan).total}` : ''}` : '';
    if (goal)
        parts.push({
            key: 'goal',
            width: 3 + goalText.length,
            drop: 800,
            node: (_jsx(Seg, { onClick: () => props.run('/goal'), children: _jsx(Text, { color: goal.status === 'active' ? 'cyan' : goal.status === 'done' ? 'green' : 'yellow', children: goalText }) }, "goal")),
        });
    if (activeAgents.length) {
        const t = `● ${activeAgents.length} agent${activeAgents.length === 1 ? '' : 's'}`;
        parts.push({
            key: 'agents',
            width: 3 + t.length,
            drop: 700,
            node: (_jsx(Seg, { onClick: openAgents, children: _jsx(Text, { color: "magenta", children: t }) }, "agents")),
        });
    }
    if (background) {
        const t = `● ${background} background${background === 1 ? '' : ' processes'}`;
        parts.push({
            key: 'background',
            width: 3 + t.length,
            drop: 600,
            node: (_jsx(Seg, { onClick: props.openShells, children: _jsx(Text, { color: "yellow", children: t }) }, "background")),
        });
    }
    const toggle = items.includes('sidebarToggle');
    const room = props.cols - 'XXXX Rein '.length - (toggle ? 4 : 0);
    const shown = new Set(parts.map((p) => p.key));
    let used = parts.reduce((n, p) => n + p.width, 0);
    for (const p of [...parts].sort((x, y) => x.drop - y.drop)) {
        if (used <= room)
            break;
        shown.delete(p.key);
        used -= p.width;
    }
    return (_jsxs(Box, { height: 1, width: props.cols, overflow: "hidden", children: [_jsxs(Text, { bold: true, children: [[...'▁▃▅▇'].map((c, i) => (_jsx(Text, { color: rainbow(i * 2, 0), children: c }, i))), ' ', "Rein", ' '] }), parts.filter((p) => shown.has(p.key)).map((p) => p.node), _jsx(Box, { flexGrow: 1 }), toggle ? (_jsx(Clickable, { onClick: props.onToggleSidebar, children: _jsx(Text, { color: props.sidebarOpen ? 'cyan' : 'gray', children: " [\u2261]" }) })) : null] }));
}
function Seg({ children, onClick }) {
    return (_jsxs(_Fragment, { children: [_jsx(Text, { dimColor: true, children: " \u2502 " }), _jsx(Clickable, { onClick: onClick, children: children })] }));
}
function Heading({ children }) {
    return (_jsx(Text, { dimColor: true, bold: true, children: children }));
}
/** Sidebar: the sections chosen in /settings, in order. */
function Sidebar({ width, height, tick, run, view, setView }) {
    const [, setUsageTick] = useState(0);
    useEffect(() => usageStore.subscribe(() => setUsageTick((t) => t + 1)), []);
    useEffect(() => {
        const on = () => setUsageTick((t) => t + 1); // milestones ticked off
        runtime.goals.on('change', on);
        return () => void runtime.goals.off('change', on);
    }, []);
    void tick;
    const inner = width - 3;
    // A goal working from a plan shows its milestones first; then the task list whenever the agent
    // keeps one (like Claude Code's todo list).
    const todos = sidebarTodos();
    const planGoal = runtime.goals.goal?.plan ? ['plan'] : [];
    const sections = [...planGoal, ...(todos.length && todos.some((t) => t.status !== 'completed') ? ['tasks'] : []), ...enabledItems('sidebar', runtime.config)];
    const render = (id) => {
        switch (id) {
            case 'plan':
                return _jsx(PlanSection, { inner: inner, run: run });
            case 'tasks':
                return _jsx(TasksSection, { inner: inner });
            case 'agents':
                return _jsx(AgentsSection, { inner: inner, view: view, setView: setView });
            case 'accounts':
                return _jsx(AccountsSection, { inner: inner, run: run });
            case 'models':
                return _jsx(ModelsSection, { inner: inner, run: run });
            case 'context':
                return _jsx(ContextSection, { inner: inner, run: run, viewing: typeof view === 'number' ? runtime.agents.get(view) : undefined });
            case 'routing':
                return _jsx(RoutingSection, { inner: inner });
            case 'session':
                return _jsx(SessionSection, { run: run });
            case 'shortcuts':
                return _jsx(ShortcutsSection, {});
            default:
                return null;
        }
    };
    return (_jsxs(Box, { flexDirection: "column", width: width, height: height, borderStyle: "single", borderLeft: true, borderTop: false, borderRight: false, borderBottom: false, borderColor: "gray", paddingLeft: 1, overflow: "hidden", children: [sections.map((id, i) => (_jsx(Box, { flexDirection: "column", marginTop: i ? 1 : 0, flexShrink: 0, children: render(id) }, id))), !sections.length && (_jsx(Clickable, { onClick: () => run('/settings'), children: _jsx(Text, { dimColor: true, children: "empty \u00B7 /settings" }) }))] }));
}
const miniBar = (pct, cells = 8) => {
    const n = Math.round((Math.min(100, pct) / 100) * cells);
    return { fill: '█'.repeat(n), rest: '░'.repeat(cells - n), color: pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green' };
};
/**
 * main + subagents that are running or being viewed (finished ones drop off once you look away;
 * /agents lists them all). Click to switch the main pane to that agent.
 */
function AgentsSection({ inner, view, setView }) {
    const shown = runtime.agents.list().filter((a) => runtime.agents.isActive(a) || a.id === view);
    return (_jsxs(_Fragment, { children: [_jsx(Heading, { children: "AGENTS" }), _jsx(Clickable, { onClick: () => setView('main'), children: _jsxs(Text, { color: view === 'main' ? 'cyan' : undefined, wrap: "truncate", children: [view === 'main' ? '▸ ' : '  ', _jsx(Text, { bold: view === 'main', children: "main" }), runtime.engine?.isBusy ? _jsx(Text, { color: "yellow", children: " \u25CF" }) : null] }) }), shown.map((a) => {
                const g = agentGlyph(a);
                return (_jsx(Clickable, { onClick: () => setView(a.id), children: _jsxs(Text, { color: view === a.id ? 'cyan' : undefined, wrap: "truncate", children: [view === a.id ? '▸ ' : '  ', _jsxs(Text, { color: g.color, children: [g.g, " "] }), _jsx(Text, { bold: view === a.id, children: truncate(a.name, Math.max(6, inner - 14)) }), _jsxs(Text, { dimColor: true, children: [" ", a.modelLabel ?? a.requested] })] }) }, a.id));
            })] }));
}
function AccountsSection({ inner, run }) {
    const accounts = [...new Map(catalog.all().flatMap((m) => m.accountIds).map((id) => [id, catalog.account(id)])).values()].filter((a) => !!a);
    return (_jsxs(_Fragment, { children: [_jsx(Heading, { children: "ACCOUNTS" }), accounts.map((a) => {
                const snap = usageStore.get(a.id);
                return (_jsx(Clickable, { onClick: () => run('/usage'), children: _jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { wrap: "truncate", children: [_jsx(Text, { bold: true, children: PROVIDERS[a.provider].name }), " ", _jsx(Text, { dimColor: true, children: truncate(accountLabel(a), inner - 8) })] }), (snap?.windows ?? []).map((w) => {
                                // Bar fills the row: ' ' + 7-char label + bar + ' ' + 4-char percent.
                                const b = miniBar(w.usedPct, Math.max(4, inner - 13));
                                return (_jsxs(Text, { wrap: "truncate", children: [' ', windowLabel(w.windowMins).padEnd(7), _jsx(Text, { color: b.color, children: b.fill }), _jsx(Text, { dimColor: true, children: b.rest }), " ", `${Math.round(w.usedPct)}%`.padStart(4)] }, w.windowMins));
                            })] }) }, a.id));
            }), !accounts.length && (_jsx(Clickable, { onClick: () => run('/login'), children: _jsx(Text, { color: "yellow", children: "+ add an account" }) }))] }));
}
function ModelsSection({ inner, run }) {
    const cfg = runtime.config;
    const selected = cfg.chatModel ?? (defaultRef(cfg) ? refKey(defaultRef(cfg)) : '');
    const models = [{ value: 'auto', label: 'auto' }, ...catalog.all().map((m) => ({ value: refKey(toRef(m)), label: `${m.label}` }))];
    return (_jsxs(_Fragment, { children: [_jsx(Heading, { children: "CHAT MODEL" }), models.map((m) => (_jsx(Clickable, { onClick: () => run(`/model ${m.value}`), children: _jsxs(Text, { color: m.value === selected ? 'cyan' : undefined, dimColor: m.value !== selected, wrap: "truncate", children: [m.value === selected ? '● ' : '○ ', truncate(m.label + (m.value === 'auto' ? '' : ` · ${PROVIDERS[parseRef(m.value).provider].name}`), inner - 2)] }) }, m.value)))] }));
}
function ContextSection({ inner, run, viewing }) {
    const pct = contextPct(viewing);
    const b = miniBar(pct, Math.max(4, inner - 5)); // bar + ' ' + 4-char percent fills the row
    return (_jsxs(_Fragment, { children: [_jsx(Heading, { children: viewing ? `CONTEXT · ${viewing.name}` : 'CONTEXT' }), _jsx(Clickable, { onClick: () => run('/context'), children: _jsxs(Text, { children: [_jsx(Text, { color: b.color, children: b.fill }), _jsx(Text, { dimColor: true, children: b.rest }), " ", `${pct}%`.padStart(4)] }) })] }));
}
function RoutingSection({ inner }) {
    const info = statusInfo();
    return (_jsxs(_Fragment, { children: [_jsx(Heading, { children: "AUTO ROUTING" }), _jsxs(Text, { dimColor: true, wrap: "truncate", children: ["decides: ", truncate(info.decider, inner - 9)] }), _jsx(Text, { wrap: "wrap", children: runtime.lastDecision ? truncate(runtime.lastDecision, inner * 2) : _jsxs(Text, { dimColor: true, children: ["no decisions yet", runtime.config.chatModel === 'auto' ? '' : ' (chat model is fixed)'] }) })] }));
}
/** The goal's plan: progress bar and milestones (✓ done, ▸ next, ○ later). */
function PlanSection({ inner, run }) {
    const g = runtime.goals.goal;
    const p = runtime.goals.plan();
    if (!g || !p)
        return null;
    const { done, total, pct } = progress(p);
    const b = miniBar(pct, Math.max(4, inner - 5));
    const next = p.milestones.findIndex((m) => !m.done);
    return (_jsxs(_Fragment, { children: [_jsx(Clickable, { onClick: () => run('/goal'), children: _jsx(Heading, { children: `GOAL · ${done}/${total}${g.status === 'active' ? '' : ` · ${g.status}`}` }) }), _jsx(Text, { wrap: "truncate", bold: true, children: truncate(p.title, inner) }), _jsxs(Text, { children: [_jsx(Text, { color: pct === 100 ? 'green' : 'cyan', children: b.fill }), _jsx(Text, { dimColor: true, children: b.rest }), " ", `${pct}%`.padStart(4)] }), p.milestones.slice(0, 12).map((m, i) => (_jsx(Text, { wrap: "truncate", color: i === next ? 'cyan' : m.done ? 'green' : undefined, dimColor: !m.done && i !== next, children: truncate(`${m.done ? '✓' : i === next ? '▸' : '○'} ${m.text}`, inner) }, i))), p.milestones.length > 12 && _jsxs(Text, { dimColor: true, children: ["\u2026 ", p.milestones.length - 12, " more"] })] }));
}
/** The task list, minus tasks that repeat the active plan's milestones (shown above it already). */
function sidebarTodos() {
    const todos = runtime.engine?.transcript.todos ?? [];
    const milestones = runtime.goals.goal?.plan ? (runtime.goals.plan()?.milestones.map((m) => m.text) ?? []) : [];
    return milestones.length ? todos.filter((t) => !isMilestoneCopy(t, milestones)) : todos;
}
function TasksSection({ inner }) {
    const todos = sidebarTodos();
    const done = todos.filter((t) => t.status === 'completed').length;
    return (_jsxs(_Fragment, { children: [_jsx(Heading, { children: `TASKS ${done}/${todos.length}` }), todos.slice(0, 12).map((t, i) => (_jsx(Text, { wrap: "truncate", color: t.status === 'in_progress' ? 'cyan' : undefined, dimColor: t.status === 'completed', strikethrough: t.status === 'completed', children: truncate(todoLine(t), inner) }, i))), todos.length > 12 && _jsxs(Text, { dimColor: true, children: ["\u2026 ", todos.length - 12, " more"] })] }));
}
function SessionSection({ run }) {
    const t = runtime.engine?.sessionTokens ?? { uncached: 0, cached: 0, output: 0 };
    const row = (label, n) => (_jsxs(Text, { wrap: "truncate", children: [_jsx(Text, { dimColor: true, children: label.padEnd(10) }), kTokens(n)] }, label));
    return (_jsxs(_Fragment, { children: [_jsx(Heading, { children: "SESSION" }), _jsxs(Text, { dimColor: true, wrap: "truncate", children: [runtime.engine?.transcript.messages.length ?? 0, " messages", runtime.engine?.transcript.summary ? ' · summarized' : ''] }), row('uncached', t.uncached), row('cached', t.cached), row('received', t.output), _jsx(Clickable, { onClick: () => run('/compact'), children: _jsx(Text, { color: "gray", children: "\u21BB compact" }) }), _jsx(Clickable, { onClick: () => run('/login'), children: _jsx(Text, { color: "gray", children: "\u2699 accounts" }) }), _jsx(Clickable, { onClick: () => run('/settings'), children: _jsx(Text, { color: "gray", children: "\u2630 settings" }) })] }));
}
function ShortcutsSection() {
    return (_jsxs(_Fragment, { children: [_jsx(Heading, { children: "SHORTCUTS" }), [
                ['esc', 'interrupt / close'],
                ['wheel', 'scroll history'],
                ['drag', 'select & copy'],
                ['⇧↵ \\↵', 'new line'],
                ['ctrl+b', 'sidebar'],
                ['/', 'commands'],
            ].map(([k, v]) => (_jsxs(Text, { wrap: "truncate", children: [_jsx(Text, { color: "cyan", children: k.padEnd(8) }), _jsx(Text, { dimColor: true, children: v })] }, k)))] }));
}
const truncate = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
/** The subagent's tool call in flight, e.g. `Edit(src/a.ts)`. */
function runningToolLabel(a) {
    const last = [...a.events].reverse().find((e) => e.kind === 'tool');
    return last && last.kind === 'tool' && last.ok === undefined ? `${last.label}(${last.summary})` : undefined;
}
