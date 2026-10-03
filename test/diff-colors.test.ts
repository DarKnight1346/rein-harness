import chalk from 'chalk';
import {afterEach, describe, expect, it} from 'vitest';
import {entryLines} from '../src/ui/fullscreen/lines.js';

const render = () =>
  entryLines({id: 1, kind: 'tool', label: 'Edit', summary: 'a.ts', ok: true, result: 'ok', diff: [{kind: 'del', line: 1, text: 'const x = 1;'}, {kind: 'add', line: 1, text: 'const x = 2;'}]} as any, 60)
    .filter((l) => l.includes('const'))
    .join('\n');
const level = chalk.level;
afterEach(() => void (chalk.level = level));

describe('diff backgrounds stay dark at every color depth', () => {
  it('256 colors: hand-picked dark palette entries, not the rounded pastel 65', () => {
    chalk.level = 2;
    const out = render();
    expect(out).toContain('\x1b[48;5;22m'); // #005f00
    expect(out).toContain('\x1b[48;5;52m'); // #5f0000
    expect(out).not.toContain('\x1b[48;5;65m');
  });
  it('truecolor: dark RGB bars', () => {
    chalk.level = 3;
    expect(render()).toContain('\x1b[48;2;22;60;30m');
  });
  it('16 colors: colored text, no background', () => {
    chalk.level = 1;
    expect(render()).not.toMatch(/\x1b\[4[0-7]m/);
  });
});

describe('diff wrapping', () => {
  it('wraps long lines instead of cutting them off, keeping every character', () => {
    chalk.level = 2;
    const long = 'Install a working OS-dev toolchain on this Intel Mac and build a from-scratch x86-64 kernel with our own UEFI bootloader end';
    const lines = entryLines({id: 1, kind: 'tool', label: 'Write', summary: 'plan.md', ok: true, result: 'ok', diff: [{kind: 'add', n: 4, text: long}]} as any, 60).filter((l) => l.includes('\x1b[48;5;22m'));
    expect(lines.length).toBeGreaterThan(1);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).join('');
    expect(plain.replace(/\s+/g, ' ')).toContain('UEFI bootloader end');
    for (const l of lines) expect(l.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(60);
  });
});
