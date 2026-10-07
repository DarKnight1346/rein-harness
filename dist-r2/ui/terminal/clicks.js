import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext, useEffect, useRef } from 'react';
import { Box } from 'ink';
/** Absolute cell rectangle of an Ink box: sum of Yoga offsets up to the root (root = 0,0). */
export function absoluteRect(node) {
    const yoga = node?.yogaNode;
    if (!yoga)
        return undefined;
    let x = 0;
    let y = 0;
    for (let n = node; n?.yogaNode; n = n.parentNode) {
        x += n.yogaNode.getComputedLeft();
        y += n.yogaNode.getComputedTop();
    }
    return { x, y, width: yoga.getComputedWidth(), height: yoga.getComputedHeight() };
}
const Ctx = createContext(undefined);
/**
 * Routes mouse events to the most specific registered box under the pointer (smallest area;
 * ties → most recently mounted, so overlays beat what they cover).
 */
export function ClickProvider({ mouse, children }) {
    const regs = useRef([]);
    const seq = useRef(0);
    const capture = useRef(undefined);
    useEffect(() => {
        if (!mouse)
            return;
        const clamp = (ev, rect) => ({
            x: Math.max(0, Math.min(rect.width - 1, ev.x - rect.x)),
            y: Math.max(-1, Math.min(rect.height, ev.y - rect.y)), // -1 / height = dragged past an edge
        });
        const onMouse = (ev) => {
            const cap = capture.current;
            if (cap && (ev.kind === 'drag' || ev.kind === 'up')) {
                const rect = absoluteRect(cap.r.ref.current) ?? cap.rect;
                if (ev.kind === 'drag')
                    cap.r.handlers.current?.onDrag?.(clamp(ev, rect), ev);
                else {
                    capture.current = undefined;
                    cap.r.handlers.current?.onDragEnd?.(clamp(ev, rect), ev);
                }
                return;
            }
            const wheel = ev.kind === 'wheelUp' || ev.kind === 'wheelDown';
            if (!wheel && !(ev.kind === 'down' && ev.button === 'left'))
                return;
            const inside = (p, rect) => p.x >= rect.x && p.x < rect.x + rect.width && p.y >= rect.y && p.y < rect.y + rect.height;
            const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
            const modal = regs.current
                .filter((r) => r.handlers.current?.modal)
                .map((r) => ({ r, rect: absoluteRect(r.ref.current) }))
                .filter((m) => !!m.rect && m.rect.width > 0)
                .sort((a, b) => b.r.seq - a.r.seq)[0];
            if (modal && !inside(ev, modal.rect)) {
                if (!wheel)
                    modal.r.handlers.current?.onOutside?.();
                return;
            }
            const hits = regs.current
                .map((r) => ({ r, rect: absoluteRect(r.ref.current) }))
                .filter((h) => !!h.rect && h.rect.width > 0 && h.rect.height > 0)
                .filter(({ r, rect }) => !modal || r === modal.r || contains(modal.rect, rect))
                .filter(({ rect }) => ev.x >= rect.x && ev.x < rect.x + rect.width && ev.y >= rect.y && ev.y < rect.y + rect.height)
                .filter(({ r }) => (wheel ? r.handlers.current?.onWheel : r.handlers.current?.onClick ?? r.handlers.current?.onDragStart))
                .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height || b.r.seq - a.r.seq);
            const hit = hits[0];
            if (!hit)
                return;
            if (wheel)
                hit.r.handlers.current?.onWheel?.(ev.kind === 'wheelUp' ? -1 : 1, ev);
            else {
                const local = { x: ev.x - hit.rect.x, y: ev.y - hit.rect.y };
                if (hit.r.handlers.current?.onDragStart) {
                    capture.current = hit;
                    hit.r.handlers.current.onDragStart(local, ev);
                }
                hit.r.handlers.current?.onClick?.(ev, local);
            }
        };
        mouse.on('mouse', onMouse);
        return () => void mouse.off('mouse', onMouse);
    }, [mouse]);
    const api = useRef({
        register(r) {
            const entry = { ...r, seq: seq.current++ };
            regs.current.push(entry);
            return () => {
                regs.current = regs.current.filter((x) => x !== entry);
            };
        },
    }).current;
    return _jsx(Ctx.Provider, { value: api, children: children });
}
/** Make an Ink <Box ref={ref}> clickable / wheel-scrollable. Handlers may change every render. */
export function useClickable(ref, handlers) {
    const ctx = useContext(Ctx);
    const h = useRef(handlers);
    h.current = handlers;
    useEffect(() => ctx?.register({ ref, handlers: h }), [ctx, ref]);
}
/** A clickable Box (no-op without a ClickProvider, e.g. in the classic renderer). `onHover` runs first, to move list selection. */
export function Clickable({ children, onClick, onHover, onWheel }) {
    const ref = useRef(null);
    useClickable(ref, {
        onClick: () => {
            onHover?.();
            onClick?.();
        },
        onWheel,
    });
    return _jsx(Box, { ref: ref, children: children });
}
