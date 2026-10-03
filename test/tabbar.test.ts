import {describe, expect, it} from 'vitest';
import {tabWindow} from '../src/ui/TabBar.js';

describe('tab bar window', () => {
  const widths = [13, 9, 11, 7, 11, 7, 16, 9, 9, 12]; // ~/configure's tabs
  it('shows everything when it fits', () => {
    expect(tabWindow(widths, 0, 200)).toEqual({start: 0, end: 10});
  });
  it('scrolls to keep the active tab visible, never wrapping', () => {
    const first = tabWindow(widths, 0, 60);
    expect(first.start).toBe(0);
    expect(first.end).toBeLessThan(10);
    const last = tabWindow(widths, 9, 60, first.start);
    expect(last.end).toBe(10);
    expect(last.start).toBeGreaterThan(0);
    for (let a = 0; a < 10; a++) {
      const w = tabWindow(widths, a, 60, 0);
      expect(a).toBeGreaterThanOrEqual(w.start);
      expect(a).toBeLessThan(w.end);
      const used = widths.slice(w.start, w.end).reduce((n, x) => n + x + 2, 0) + (w.start > 0 ? 2 : 0) + (w.end < 10 ? 2 : 0);
      expect(used).toBeLessThanOrEqual(60);
    }
  });
});
