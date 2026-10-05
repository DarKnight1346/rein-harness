import {describe, expect, it} from 'vitest';
import {needsBidi, visualOrder} from '../src/ui/bidi.js';

describe('right-to-left text in visual order', () => {
  it('leaves left-to-right lines alone', () => {
    expect(visualOrder('\x1b[1mhello\x1b[22m world')).toBe('\x1b[1mhello\x1b[22m world');
  });
  it('reverses a Hebrew word inside an English sentence', () => {
    expect(visualOrder('say שלום to them')).toBe('say םולש to them');
  });
  it('lays out a right-to-left line: words right to left, numbers and English still left to right', () => {
    expect(visualOrder('שלום 123 world')).toBe('world 123 םולש');
    expect(visualOrder('  שלום עולם')).toBe('  םלוע םולש'); // indentation kept
  });
  it('mirrors brackets inside right-to-left runs', () => {
    expect(visualOrder('שלום (עולם)')).toBe('(םלוע) םולש');
  });
  it('keeps Arabic combining marks with their letter', () => {
    const out = visualOrder('مَرحبا');
    expect(out.startsWith('ا')).toBe(true);
    expect(out.endsWith('مَ')).toBe(true); // the fatha stays after its mim
  });
  it('only where the terminal does not do it itself', () => {
    expect(needsBidi({TERM_PROGRAM: 'Apple_Terminal'})).toBe(false);
    expect(needsBidi({VTE_VERSION: '7600'})).toBe(false);
    expect(needsBidi({TERM_PROGRAM: 'vscode'})).toBe(true);
    expect(needsBidi({WT_SESSION: 'x'})).toBe(true);
    expect(needsBidi({TERM_PROGRAM: 'Apple_Terminal'}, 'on')).toBe(true);
    expect(needsBidi({TERM_PROGRAM: 'vscode'}, 'off')).toBe(false);
  });
});
