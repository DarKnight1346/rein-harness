import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { VaultPrompt } from './VaultPrompt.js';
import { voiceNote } from './useRein.js';
import { useEffect, useRef, useState } from 'react';
import { skillSourceLabel } from '../skills/index.js';
import { Box, Static, Text, useStdout } from 'ink';
import { detectGraphics, imagePaths, inlineImage } from './terminal/images.js';
import { needsBidi, visualOrder } from './bidi.js';
import { approvalNote, compactText, routeLabel, toolResultSummary } from './format.js';
import { ImportPrompt } from './ImportPrompt.js';
import { TrustHooksPrompt } from './TrustHooksPrompt.js';
import { HistorySearch } from './HistorySearch.js';
import { LoginScreen } from './LoginScreen.js';
import { ModelScreen } from './ModelScreen.js';
import { ConfigureScreen } from './ConfigureScreen.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ResumeScreen } from './ResumeScreen.js';
import { RewindScreen } from './RewindScreen.js';
import { McpScreen } from './McpScreen.js';
import { PlanScreen } from './PlanScreen.js';
import { AskScreen } from './AskScreen.js';
import { PlansScreen } from './PlansScreen.js';
import { StatusBar } from './StatusBar.js';
import { UsageReport } from './UsageReport.js';
import { TextInput } from './TextInput.js';
import { rainbow, Working } from './Working.js';
import { ContextView } from './ContextView.js';
import { useRein } from './useRein.js';
import { diffLines } from './fullscreen/lines.js';
import { planPreviewLines } from './planPreview.js';
import { renderMarkdown } from './markdown.js';
import { redact } from './privacy.js';
import { runtime } from '../runtime.js';
import { shellStatusText } from '../tools/shells.js';
import { useShellsTick } from './fullscreen/Shells.js';
/** Classic renderer: a running foreground command's last lines, live, above the input. */
function ForegroundTail() {
    useShellsTick();
    const s = runtime.tools.shells.running({ background: false })[0];
    if (!s)
        return null;
    return (_jsxs(Box, { flexDirection: "column", paddingLeft: 2, children: [_jsxs(Text, { color: "yellow", wrap: "truncate", children: ["$ ", s.command, " ", _jsxs(Text, { dimColor: true, children: ["\u00B7 ", shellStatusText(s), s.tty ? (s.waiting ? ' · waiting for you: ctrl+] to answer' : ' · ctrl+] to type into it') : '', " \u00B7 esc interrupts"] })] }), s.lines.slice(-8).map((l, i) => (_jsxs(Text, { dimColor: true, wrap: "truncate", children: ['  ', l || ' '] }, i)))] }));
}
/** Classic renderer: inline in the main screen, transcript in native scrollback via <Static>. */
/**
 * Images the agent made or read, drawn into the scrollback under their tool line where the
 * terminal can (terminal/images.ts). Written through Ink's stdout, which keeps the live area
 * below intact; each image once.
 */
function useInlineImages(entries) {
    const { write } = useStdout();
    const shown = useRef(new Set());
    const graphics = useRef(detectGraphics());
    useEffect(() => {
        if (graphics.current === 'none' || runtime.config.inlineImages === 'off')
            return;
        for (const e of entries) {
            if ((e.kind !== 'tool' && e.kind !== 'user') || shown.current.has(e.id))
                continue;
            shown.current.add(e.id);
            const t = e;
            const files = e.kind === 'user' ? (t.images ?? []) : t.ok && IMAGE_TOOLS.has(t.label) ? imagePaths(t.result, process.cwd()) : [];
            for (const file of files) {
                const img = inlineImage(file, graphics.current, Math.min(60, (process.stdout.columns ?? 80) - 4));
                if (img)
                    write(img);
            }
        }
    }, [entries, write]);
}
const IMAGE_TOOLS = new Set(['ImageGen', 'Read']);
/** Right-to-left text in visual order, for terminals that don't lay it out themselves (bidi.ts). */
const rtl = (text) => (needsBidi(process.env, runtime.config.rtl ?? 'auto') ? text.split('\n').map(visualOrder).join('\n') : text);
export function ClassicApp({ resume }) {
    // <Static> only prints items past the count it has already rendered; remount it on /clear.
    const [generation, setGeneration] = useState(0);
    const r = useRein({
        resume,
        renderer: 'classic',
        onClear: () => {
            process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
            setGeneration((g) => g + 1);
        },
    });
    const { chat, overlay } = r;
    useInlineImages(r.transcript);
    return (_jsxs(_Fragment, { children: [_jsx(Static, { items: r.transcript, children: (e) => _jsx(EntryView, { entry: e }, e.id) }, generation), _jsxs(Box, { flexDirection: "column", children: [chat.live ? (_jsx(Box, { paddingLeft: 2, children: _jsx(Text, { children: chat.live }) })) : null, _jsx(ForegroundTail, {}), chat.busy ? (_jsx(Working, { startedAt: chat.startedAt, phase: chat.phase, tool: chat.toolLabel, tokens: chat.tokens, queued: r.queued.length, waitUntil: chat.waitUntil })) : r.compacting ? (_jsx(Working, { startedAt: r.compacting.startedAt, phase: "tool", tool: r.compacting.label })) : r.goalNote ? (_jsx(Working, { startedAt: r.goalNote.startedAt, phase: "tool", tool: r.goalNote.label })) : null, overlay.name === 'import' && _jsx(ImportPrompt, { rows: overlay.rows, onImport: () => r.finishImport(true), onSkip: () => r.finishImport(false) }), overlay.name === 'history' && (_jsx(Box, { borderStyle: "round", borderColor: "cyan", paddingX: 1, flexDirection: "column", children: _jsx(HistorySearch, { entries: overlay.entries, onPick: r.pickHistory, onCancel: () => r.pickHistory(undefined) }) })), overlay.name === 'trust' && _jsx(TrustHooksPrompt, { hooks: overlay.hooks, onTrust: () => r.finishTrust(true), onSkip: () => r.finishTrust(false) }), overlay.name === 'login' && _jsx(LoginScreen, { onLog: r.log, onClose: r.closeOverlay }), overlay.name === 'vault' && (_jsx(Box, { borderStyle: "round", borderColor: "cyan", paddingX: 1, flexDirection: "column", children: _jsx(VaultPrompt, { secret: overlay.secret, onSave: (v) => r.saveVault(overlay.secret, v), onCancel: r.closeOverlay }) })), overlay.name === 'model' && _jsx(ModelScreen, { onLog: r.log, onClose: r.closeOverlay }), overlay.name === 'resume' && _jsx(ResumeScreen, { sessions: overlay.sessions, onPick: (id) => void r.pickSession(id), onCancel: r.closeOverlay }), overlay.name === 'mcp' && _jsx(McpScreen, { onClose: r.closeOverlay }), overlay.name === 'plans' && _jsx(PlansScreen, { plans: overlay.plans, onPick: r.startPlanGoal, onNew: r.startNewPlan, onCancel: r.closeOverlay }), overlay.name === 'ask' && _jsx(AskScreen, { questions: overlay.questions, onDone: overlay.resolve }), overlay.name === 'plan' && _jsx(PlanScreen, { plan: overlay.plan, width: (process.stdout.columns ?? 100) - 4, onDecide: overlay.resolve }), overlay.name === 'rewind' && _jsx(RewindScreen, { points: overlay.points, onPick: (i, m) => void r.doRewind(i, m), onCancel: r.closeOverlay }), overlay.name === 'settings' && _jsx(ConfigureScreen, { onClose: r.closeOverlay, onChange: r.bump }), overlay.name === 'approval' && _jsx(ApprovalPrompt, { req: overlay.req, onDecide: overlay.resolve }), _jsxs(Box, { borderStyle: "round", borderColor: r.inputActive ? 'gray' : 'blackBright', paddingX: 1, children: [_jsx(Text, { color: "gray", children: '> ' }), _jsx(TextInput, { isActive: r.inputActive, value: r.draft, onChange: r.onDraft, onPaste: r.onPaste, onImagePaste: r.onImagePaste, onHistory: r.onHistory, onExternalEdit: r.onExternalEdit, placeholder: !r.ready ? 'starting…' : chat.busy ? 'queue a message, or /btw <question>' : 'message or /help', onSubmit: r.onSubmit })] }), r.inputActive && r.suggestions.length > 0 ? (_jsx(Box, { flexDirection: "column", paddingLeft: 2, children: r.suggestions.map((c) => (_jsxs(Text, { color: c === r.selected ? 'cyan' : undefined, dimColor: c !== r.selected, children: [`/${c.name}`.padEnd(12), c.description, c.skill ? _jsxs(Text, { dimColor: true, children: [" \u00B7 ", c.skill.plugin ? `plugin ${c.skill.plugin}` : skillSourceLabel(c.skill.source), c.skill.argumentHint ? ` · ${c.skill.argumentHint}` : ''] }) : null] }, c.name))) })) : r.inputActive && r.fileSuggestions.length > 0 ? (_jsx(Box, { flexDirection: "column", paddingLeft: 2, children: r.fileSuggestions.map((f) => (_jsxs(Text, { color: f === r.fileSelected ? 'cyan' : undefined, dimColor: f !== r.fileSelected, children: ["@", f] }, f))) })) : r.exitArmed ? (_jsxs(Text, { color: "yellow", children: ['  ', "Press Ctrl+C again to exit"] })) : r.voice !== 'idle' ? (_jsxs(Text, { color: r.voice === 'recording' ? 'red' : 'cyan', children: ['  ', voiceNote(r.voice)] })) : (_jsx(StatusBar, { tick: r.statusTick }))] })] }));
}
function EntryView({ entry: raw }) {
    // Hide personal info: redact the entry's text fields (emails → "Claude Account 1", home → ~).
    const entry = redactEntry(raw);
    switch (entry.kind) {
        case 'banner':
            return (_jsxs(Box, { marginBottom: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["\u2581\u2583\u2585\u2587 ", entry.text] }), _jsx(Text, { dimColor: true, children: "  /help for commands" })] }));
        case 'user':
            return (_jsxs(Box, { marginTop: 1, children: [_jsx(Text, { color: "gray", children: '> ' }), _jsx(Text, { children: rtl(entry.text) })] }));
        case 'assistant': {
            const md = rtl(renderMarkdown(entry.text.replace(/\s+$/, ''), (process.stdout.columns ?? 100) - 4).join('\n'));
            return entry.first ? (_jsxs(Box, { marginTop: 1, children: [_jsx(Text, { children: "\u23FA " }), _jsx(Text, { children: md })] })) : (_jsx(Box, { paddingLeft: 2, children: _jsx(Text, { children: md }) }));
        }
        case 'compact': {
            const { stats, why } = compactText(entry.reason, entry.result, runtime.config.autoCompactPct);
            return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { children: [_jsx(Text, { color: "cyan", children: "\u2500\u2500 " }), [...'▁▃▅▇'].map((c, i) => (_jsx(Text, { color: rainbow(i * 2, 0), children: c }, i))), _jsx(Text, { bold: true, color: "cyan", children: " Conversation compacted " }), _jsx(Text, { color: "cyan", children: '─'.repeat(30) })] }), _jsxs(Text, { children: ["  ", stats] }), _jsxs(Text, { dimColor: true, children: ["  ", why] })] }));
        }
        case 'tool':
            return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { children: [_jsx(Text, { color: entry.ok ? 'green' : 'red', children: "\u23FA " }), _jsx(Text, { bold: true, children: entry.label }), _jsxs(Text, { dimColor: true, children: ["(", entry.summary, ")", approvalNote(entry.approvedBy, entry.judge)] })] }), _jsxs(Text, { color: entry.ok ? undefined : 'red', dimColor: entry.ok, wrap: "truncate", children: ['  ⎿ ', toolResultSummary(entry.label, entry.result)] }), entry.plan ? (_jsx(Text, { children: planPreviewLines(entry.plan, (process.stdout.columns ?? 100) - 2).join('\n') })) : entry.diff?.length ? (_jsx(Text, { children: diffLines(entry.diff, (process.stdout.columns ?? 100) - 2, entry.summary).join('\n') })) : null] }));
        case 'route':
            return (_jsxs(Text, { dimColor: true, children: ['  ', "\u2192 ", routeLabel(entry.route, entry.account, entry.effort), entry.interrupted ? _jsx(Text, { color: "yellow", children: " \u00B7 interrupted" }) : null] }));
        case 'context':
            return _jsx(ContextView, { report: entry.report });
        case 'usage':
            return _jsx(UsageReport, { rows: entry.rows, jev: entry.jev });
        case 'update': {
            const { text, level } = entry.line;
            if (level === 'output')
                return _jsxs(Text, { dimColor: true, children: ['      ', text] });
            const color = level === 'ok' ? 'green' : level === 'warn' ? 'yellow' : level === 'error' ? 'red' : undefined;
            return _jsx(Text, { color: color, dimColor: !color, children: indent(level === 'info' ? `$ ${text}` : text) });
        }
        case 'info':
            return _jsx(Text, { dimColor: true, children: indent(entry.text) });
        case 'error':
            return _jsx(Text, { color: "red", children: indent(entry.text) });
    }
}
/** Claude-Code-style result gutter: first line gets `⎿`, continuation lines align under it. */
function indent(text) {
    return text
        .split('\n')
        .map((line, i) => (i === 0 ? '  ⎿ ' : '    ') + line)
        .join('\n');
}
function redactEntry(e) {
    const out = { ...e };
    for (const k of ['text', 'summary', 'result'])
        if (typeof out[k] === 'string')
            out[k] = redact(out[k]);
    return out;
}
