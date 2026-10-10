import React, {useEffect, useRef, useState, type ReactNode} from 'react';
import {Box, Text, useBoxMetrics, useInput, useWindowSize} from 'ink';
import {Clickable, useClickable} from '../terminal/clicks.js';
import {redact} from '../privacy.js';
import {accent} from '../theme.js';

/** Window background: masks whatever is underneath (Ink paints later siblings over earlier ones). */
// Pure grey (equal RGB) so 256-color terminals map it onto the grey ramp (235), not a blue cube color.
export const WINDOW_BG = '#262626';

/**
 * A centered window drawn over the whole screen (absolute position, own background), so the
 * conversation keeps streaming underneath. Its size is stable: with `height` (tabbed windows) it is
 * fixed; otherwise it fits the content but never shrinks while open (no jumping as content changes).
 */
export function Window({title, width, height: fixed, children, onClose, footer, dismissable = true, color = accent()}: {title: string; width?: number; height?: number; children: ReactNode; onClose(): void; footer?: string; dismissable?: boolean; color?: string}) {
  const {columns, rows} = useWindowSize();
  const ref = useRef(null);
  const {height, hasMeasured} = useBoxMetrics(ref);
  const [tallest, setTallest] = useState(0);
  useEffect(() => {
    if (hasMeasured && !fixed && height > tallest) setTallest(height);
  }, [height, hasMeasured, fixed, tallest]);
  const boxHeight = fixed ? Math.min(fixed, rows - 2) : undefined;
  const minHeight = !fixed && tallest ? Math.min(tallest, rows - 2) : undefined;
  // Modal for the mouse: clicks outside close the window, nothing underneath is clickable.
  // Non-dismissable windows (approvals) ignore outside clicks: a stray click must not decide.
  useClickable(ref, {modal: true, onOutside: dismissable ? onClose : () => {}});
  const w = Math.min(width ?? 90, columns - 4);
  const left = Math.max(0, Math.floor((columns - w) / 2));
  // Centered once measured; the first frame sits at the top (never past the screen edge, which would overflow the frame).
  const top = hasMeasured ? Math.max(1, Math.floor((rows - height) / 2)) : 1;
  return (
    <Box ref={ref} position="absolute" top={top} left={left} width={w} {...(boxHeight ? {height: boxHeight, overflow: 'hidden' as const} : {})} {...(minHeight ? {minHeight} : {})} flexDirection="column" borderStyle="round" borderColor={color} backgroundColor={WINDOW_BG} paddingX={1}>
      <Box>
        <Text bold color={color}>
          {title}
        </Text>
        <Box flexGrow={1} />
        {dismissable ? (
          <Clickable onClick={onClose}>
            <Text color="gray">[×]</Text>
          </Clickable>
        ) : null}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
      {footer ? <Text dimColor>{footer}</Text> : null}
    </Box>
  );
}

/**
 * Read-only window over pre-rendered lines (usage, context, help, update log) with scrolling:
 * ↑↓ / PgUp/PgDn / wheel; Esc, q or Enter closes.
 */
export function InfoWindow({title, lines, onClose, width, follow, onKey, hint}: {
  title: string;
  lines: string[];
  onClose(): void;
  width?: number;
  follow?: boolean;
  /** Extra keys (e.g. `k` to kill a shell); return true if handled. */
  onKey?: (input: string) => boolean | void;
  /** Extra footer hint, e.g. `k kill`. */
  hint?: string;
}) {
  const {rows} = useWindowSize();
  const viewport = Math.max(3, Math.min(lines.length, rows - 8));
  const maxTop = Math.max(0, lines.length - viewport);
  const [top, setTop] = useState(0);
  // `follow` (update log): stay pinned to the newest line unless the user scrolled up.
  const [pinned, setPinned] = useState(true);
  const start = follow && pinned ? maxTop : Math.min(top, maxTop);
  const scroll = (n: number) => {
    const next = Math.max(0, Math.min(maxTop, start + n));
    setTop(next);
    setPinned(next >= maxTop);
  };
  useInput((input, key) => {
    if (onKey?.(input)) return;
    if (key.escape || key.return || input === 'q') onClose();
    else if (key.upArrow) scroll(-1);
    else if (key.downArrow) scroll(1);
    else if (key.pageUp) scroll(-(viewport - 1));
    else if (key.pageDown) scroll(viewport - 1);
  });
  const more = lines.length > viewport;
  return (
    <Window
      title={title}
      width={width}
      onClose={onClose}
      footer={`${more ? `${start + 1}–${start + viewport} of ${lines.length} · ↑↓/wheel scroll · ` : ''}${hint ? `${hint} · ` : ''}esc close`}
    >
      <Clickable onWheel={(dir) => scroll(dir * 3)}>
        <Box flexDirection="column" height={viewport} overflow="hidden">
          {lines.slice(start, start + viewport).map((l, i) => (
            <Text key={i} wrap="truncate">
              {redact(l) || ' '}
            </Text>
          ))}
        </Box>
      </Clickable>
    </Window>
  );
}
