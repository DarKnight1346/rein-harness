import {describe, expect, it} from 'vitest';
import {commandListRows, listWindow} from '../src/ui/format.js';

describe('the / command list window', () => {
  it('shows everything when it fits', () => {
    expect(listWindow(5, 2, 10)).toEqual({start: 0, end: 5, above: 0, below: 0});
  });
  it('scrolls with the selection and counts what is hidden', () => {
    expect(listWindow(60, 0, 10)).toEqual({start: 0, end: 10, above: 0, below: 50});
    expect(listWindow(60, 30, 10)).toEqual({start: 25, end: 35, above: 25, below: 25});
    expect(listWindow(60, 59, 10)).toEqual({start: 50, end: 60, above: 50, below: 0});
  });
  it('takes fewer rows on a short terminal', () => {
    expect(commandListRows(50)).toBe(10);
    expect(commandListRows(20)).toBe(6);
    expect(commandListRows(10)).toBe(3);
  });
});
