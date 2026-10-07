import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { Box, Text, useBoxMetrics, useInput, useWindowSize } from 'ink';
import { Clickable, useClickable } from '../terminal/clicks.js';
import { redact } from '../privacy.js';
/** Window background: masks whatever is underneath (Ink paints later siblings over earlier ones). */
// Pure grey (equal RGB) so 256-color terminals map it onto the grey ramp (235), not a blue cube color.
export const WINDOW_BG = '#262626';
/**
 * A centered window drawn over the whole screen (absolute position, own background), so the
 * conversation keeps streaming underneath. Its size is stable: with `height` (tabbed windows) it is
 * fixed; otherwise it fits the content but never shrinks while open (no jumping as content changes).
 */
export function Window({ title, width, height: fixed, children, onClose, footer, dismissable = true, color = 'cyan' }) {
    const { columns, rows } = useWindowSize();
    const ref = useRef(null);
    const { height, hasMeasured } = useBoxMetrics(ref);
    const [tallest, setTallest] = useState(0);
    useEffect(() => {
        if (hasMeasured && !fixed && height > tallest)
            setTallest(height);
    }, [height, hasMeasured, fixed, tallest]);
    const boxHeight = fixed ? Math.min(fixed, rows - 2) : undefined;
    const minHeight = !fixed && tallest ? Math.min(tallest, rows - 2) : undefined;
    // Modal for the mouse: clicks outside close the window, nothing underneath is clickable.
    // Non-dismissable windows (approvals) ignore outside clicks: a stray click must not decide.
    useClickable(ref, { modal: true, onOutside: dismissable ? onClose : () => { } });
    const w = Math.min(width ?? 90, columns - 4);
    const left = Math.max(0, Math.floor((columns - w) / 2));
    // Centered once measured; the first frame sits at the top (never past the screen edge, which would overflow the frame).
    const top = hasMeasured ? Math.max(1, Math.floor((rows - height) / 2)) : 1;
    return (_jsxs(Box, { ref: ref, position: "absolute", top: top, left: left, width: w, ...(boxHeight ? { height: boxHeight, overflow: 'hidden' } : {}), ...(minHeight ? { minHeight } : {}), flexDirection: "column", borderStyle: "round", borderColor: color, backgroundColor: WINDOW_BG, paddingX: 1, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: color, children: title }), _jsx(Box, { flexGrow: 1 }), dismissable ? (_jsx(Clickable, { onClick: onClose, children: _jsx(Text, { color: "gray", children: "[\u00D7]" }) })) : null] }), _jsx(Box, { flexDirection: "column", flexGrow: 1, children: children }), footer ? _jsx(Text, { dimColor: true, children: footer }) : null] }));
}
/**
 * Read-only window over pre-rendered lines (usage, context, help, update log) with scrolling:
 * ↑↓ / PgUp/PgDn / wheel; Esc, q or Enter closes.
 */
export function InfoWindow({ title, lines, onClose, width, follow, onKey, hint }) {
    const { rows } = useWindowSize();
    const viewport = Math.max(3, Math.min(lines.length, rows - 8));
    const maxTop = Math.max(0, lines.length - viewport);
    const [top, setTop] = useState(0);
    // `follow` (update log): stay pinned to the newest line unless the user scrolled up.
    const [pinned, setPinned] = useState(true);
    const start = follow && pinned ? maxTop : Math.min(top, maxTop);
    const scroll = (n) => {
        const next = Math.max(0, Math.min(maxTop, start + n));
        setTop(next);
        setPinned(next >= maxTop);
    };
    useInput((input, key) => {
        if (onKey?.(input))
            return;
        if (key.escape || key.return || input === 'q')
            onClose();
        else if (key.upArrow)
            scroll(-1);
        else if (key.downArrow)
            scroll(1);
        else if (key.pageUp)
            scroll(-(viewport - 1));
        else if (key.pageDown)
            scroll(viewport - 1);
    });
    const more = lines.length > viewport;
    return (_jsx(Window, { title: title, width: width, onClose: onClose, footer: `${more ? `${start + 1}–${start + viewport} of ${lines.length} · ↑↓/wheel scroll · ` : ''}${hint ? `${hint} · ` : ''}esc close`, children: _jsx(Clickable, { onWheel: (dir) => scroll(dir * 3), children: _jsx(Box, { flexDirection: "column", height: viewport, overflow: "hidden", children: lines.slice(start, start + viewport).map((l, i) => (_jsx(Text, { wrap: "truncate", children: redact(l) || ' ' }, i))) }) }) }));
}
