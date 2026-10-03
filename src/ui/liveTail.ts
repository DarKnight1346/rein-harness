import stringWidth from 'string-width';

/**
 * Ink full-clears the terminal whenever the dynamic region reaches the terminal height, which
 * is the main source of flicker. Streaming text is therefore split: whole lines that no longer
 * fit in `maxRows` (counted as *wrapped* terminal rows, not '\n's) are committed to <Static>,
 * and only the tail stays live. The last line is always kept live since it may still grow.
 */
export function splitLiveTail(text: string, maxRows: number, columns: number): {committed: string; live: string} {
  const lines = text.split('\n');
  const rowsOf = (line: string) => Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, columns)));
  let rows = 0;
  let cut = lines.length;
  while (cut > 0 && rows + rowsOf(lines[cut - 1]!) <= maxRows) rows += rowsOf(lines[--cut]!);
  cut = Math.min(cut, lines.length - 1);
  if (cut <= 0) return {committed: '', live: text};
  return {committed: lines.slice(0, cut).join('\n'), live: lines.slice(cut).join('\n')};
}

/** Live block budget: ~12 rows, less on short terminals so input + status bar always fit. */
export function liveRowBudget(terminalRows: number): number {
  return Math.max(3, Math.min(12, terminalRows - 8));
}
