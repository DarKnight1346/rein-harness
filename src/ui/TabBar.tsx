import React, {useRef} from 'react';
import {Box, Text, useBoxMetrics} from 'ink';
import stringWidth from 'string-width';
import {Clickable} from './terminal/clicks.js';

const GAP = 2;
const ARROW = 2; // "‹ " / " ›"

/** Tab label as shown: the selected one in brackets. */
const label = (title: string, on: boolean) => (on ? `[${title}]` : ` ${title} `);

/**
 * The visible slice [start, end) of tabs: everything when it fits, otherwise a window that keeps
 * `active` in view (scrolling left/right as it moves), leaving room for the ‹ › markers.
 */
export function tabWindow(widths: number[], active: number, avail: number, prevStart = 0): {start: number; end: number} {
  const total = widths.reduce((n, w) => n + w + GAP, 0);
  if (total <= avail) return {start: 0, end: widths.length};
  const fits = (s: number, e: number) => widths.slice(s, e).reduce((n, w) => n + w + GAP, 0) + (s > 0 ? ARROW : 0) + (e < widths.length ? ARROW : 0) <= avail;
  let start = Math.min(prevStart, active);
  // Move right until the active tab fits after `start`.
  while (start < active && !fits(start, active + 1)) start++;
  let end = active + 1;
  while (end < widths.length && fits(start, end + 1)) end++;
  // Use leftover room on the left too (e.g. at the last tab).
  while (start > 0 && fits(start - 1, end)) start--;
  return {start, end: Math.max(end, start + 1)};
}

/** One-line tab bar that scrolls instead of wrapping when the tabs don't fit. */
export function TabBar({titles, active, onSelect}: {titles: string[]; active: number; onSelect(i: number): void}) {
  const ref = useRef(null);
  const {width} = useBoxMetrics(ref);
  const startRef = useRef(0);
  const widths = titles.map((t, i) => stringWidth(label(t, i === active)));
  const {start, end} = tabWindow(widths, active, width || 80, startRef.current);
  startRef.current = start;
  return (
    <Box ref={ref} flexDirection="row" flexWrap="nowrap" overflow="hidden" width="100%">
      {start > 0 && (
        <Clickable onClick={() => onSelect(start - 1)}>
          <Text dimColor>‹ </Text>
        </Clickable>
      )}
      {titles.slice(start, end).map((title, k) => {
        const i = start + k;
        return (
          <Box key={title} flexShrink={0}>
            <Clickable onClick={() => onSelect(i)}>
              <Text wrap="truncate" color={i === active ? 'cyan' : undefined} bold={i === active} dimColor={i !== active}>
                {label(title, i === active)}
                {' '.repeat(GAP)}
              </Text>
            </Clickable>
          </Box>
        );
      })}
      {end < titles.length && (
        <Clickable onClick={() => onSelect(end)}>
          <Text dimColor> ›</Text>
        </Clickable>
      )}
    </Box>
  );
}
