import {describe, expect, it} from 'vitest';
import {absoluteRect} from '../src/ui/terminal/clicks.js';
import {decode, splitMouse} from '../src/ui/terminal/mouse.js';
import {lineRange, selectedText} from '../src/ui/fullscreen/selection.js';
import {entryLines, wrap} from '../src/ui/fullscreen/lines.js';

describe('mouse parsing', () => {
  it('strips SGR mouse sequences and decodes them', () => {
    const {text, events, pending} = splitMouse('ab\x1b[<0;10;5Mc\x1b[<0;10;5m\x1b[<64;3;4M\x1b[<32;11;5M\x1b[<1');
    expect(text).toBe('abc');
    expect(pending).toBe('\x1b[<1');
    expect(events.map((e) => [e.kind, e.button, e.x, e.y])).toEqual([
      ['down', 'left', 9, 4],
      ['up', 'left', 9, 4],
      ['wheelUp', 'none', 2, 3],
      ['drag', 'left', 10, 4],
    ]);
  });
  it('leaves keys, escapes and kitty replies alone', () => {
    expect(splitMouse('\x1b[A\x1b\x1b[?1u').text).toBe('\x1b[A\x1b\x1b[?1u');
    expect(decode(65, 1, 1, 'M').kind).toBe('wheelDown');
    expect(decode(4, 1, 1, 'M').shift).toBe(true);
  });
});

describe('hit testing', () => {
  it('sums yoga offsets up the tree', () => {
    const node = (l: number, t: number, w: number, h: number, parentNode?: any) => ({parentNode, yogaNode: {getComputedLeft: () => l, getComputedTop: () => t, getComputedWidth: () => w, getComputedHeight: () => h}});
    const root = node(0, 0, 100, 30);
    const pane = node(2, 1, 50, 20, root);
    expect(absoluteRect(node(3, 4, 10, 1, pane))).toEqual({x: 5, y: 5, width: 10, height: 1});
  });
});

describe('selection', () => {
  const lines = ['\x1b[31mhello world\x1b[39m', 'second line', 'third'];
  it('extracts plain text across lines in either drag direction', () => {
    expect(selectedText({anchor: {line: 0, col: 6}, focus: {line: 1, col: 5}}, lines)).toBe('world\nsecond');
    expect(selectedText({anchor: {line: 1, col: 5}, focus: {line: 0, col: 6}}, lines)).toBe('world\nsecond');
    expect(lineRange({anchor: {line: 0, col: 2}, focus: {line: 2, col: 1}}, 1, 11)).toEqual([0, 11]);
  });
});

describe('fullscreen lines', () => {
  it('wraps with hanging indents and never leaks extra args into notices', () => {
    expect(wrap('aaaa bbbb cccc', 12, '> ')).toEqual(['> aaaa bbbb', '  cccc']);
    const out = entryLines({id: 1, kind: 'info', text: 'x'}, 40).join('');
    expect(out).toContain('⎿ x');
    expect(out).not.toMatch(/\bx 0\b/);
  });
});

describe('layout config', () => {
  it('uses defaults, keeps configured order and drops unknown ids', async () => {
    const {enabledItems, DEFAULT_STATUS, DEFAULT_SIDEBAR} = await import('../src/ui/layout.js');
    const {DEFAULT_CONFIG} = await import('../src/store/config.js');
    expect(enabledItems('status', DEFAULT_CONFIG)).toEqual(DEFAULT_STATUS);
    expect(enabledItems('sidebar', DEFAULT_CONFIG)).toEqual(DEFAULT_SIDEBAR);
    expect(enabledItems('sidebar', {...DEFAULT_CONFIG, sidebarSections: ['session', 'bogus', 'accounts']})).toEqual(['session', 'accounts']);
    expect(enabledItems('status', {...DEFAULT_CONFIG, statusLine: []})).toEqual([]);
  });
  it('/settings opens the settings; the old /configure and /config names are gone', async () => {
    const {parseInput} = await import('../src/commands/index.js');
    expect(parseInput('/settings')).toEqual({kind: 'command', name: 'settings', args: ''});
    expect(parseInput('/configure')).toEqual({kind: 'unknown', name: 'configure'});
    expect(parseInput('/config')).toEqual({kind: 'unknown', name: 'config'});
  });
});

describe('long tool lines', () => {
  it('wrap within the pane width (never push the sidebar)', async () => {
    const stringWidth = (await import('string-width')).default;
    const lines = entryLines({id: 1, kind: 'tool', label: 'Shell', summary: '$ ' + 'x'.repeat(200), ok: true, result: '[exit 0 after 1s]\nok', approvedBy: 'auto', judge: '0.97 via Jev'}, 60);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(60);
  });
});
