import {mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import {describe, expect, it} from 'vitest';
import {cellsFor, detectGraphics, imagePaths, inlineImage, itermImage, kittyImage, kittyPlaceholder, pngSize} from '../src/ui/terminal/images.js';

const png = (w: number, h: number) => {
  const b = Buffer.alloc(40);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

describe('terminal images', () => {
  it('knows which terminals draw images', () => {
    expect(detectGraphics({TERM: 'xterm-kitty'})).toBe('kitty');
    expect(detectGraphics({TERM_PROGRAM: 'ghostty'})).toBe('kitty');
    expect(detectGraphics({TERM_PROGRAM: 'iTerm.app'})).toBe('iterm');
    expect(detectGraphics({TERM_PROGRAM: 'WezTerm'})).toBe('iterm');
    expect(detectGraphics({TERM_PROGRAM: 'Apple_Terminal'})).toBe('none');
    expect(detectGraphics({TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/x'})).toBe('none');
  });
  it('finds image files in a tool result', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-img-'));
    writeFileSync(path.join(dir, 'cat.png'), png(10, 10));
    const r = `Generated 1 image in 9s via GPT Image:\n${path.join(dir, 'cat.png')}\n${path.join(dir, 'missing.png')}`;
    expect(imagePaths(r, dir)).toEqual([path.join(dir, 'cat.png')]);
  });
  it('sizes images in cells and encodes both protocols', () => {
    expect(pngSize(png(1024, 512))).toEqual({width: 1024, height: 512});
    expect(pngSize(Buffer.from('not a png at all, really'))).toBeUndefined();
    expect(cellsFor({width: 1024, height: 1024}, 40, 30)).toEqual({cols: 40, rows: 20}); // cells are ~2:1
    expect(cellsFor({width: 400, height: 4000}, 40, 30)).toEqual({cols: 6, rows: 30}); // tall: limited by rows
    expect(itermImage(Buffer.from('xy'), 12)).toBe('\x1b]1337;File=inline=1;size=2;width=12;preserveAspectRatio=1:eHk=\x07');
    const big = Buffer.alloc(10_000, 7);
    const k = kittyImage(big, 10, 5, {id: 42, virtual: true});
    const chunks = k.split('\x1b\\').filter(Boolean);
    expect(chunks[0]).toMatch(/^\x1b_Ga=T,f=100,q=2,c=10,r=5,i=42,U=1,m=1;/);
    expect(chunks.at(-1)).toMatch(/^\x1b_Gm=0;/);
    expect(chunks.every((c) => c.length <= 4096 + 60)).toBe(true);
  });
  it('placeholders take exactly the image cells (so layout and truncation hold)', () => {
    const lines = kittyPlaceholder(0x100001, 7, 3);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(stringWidth(l)).toBe(7);
    expect(lines[0]).toContain('\x1b[38;2;16;0;1m'); // the id, as the foreground color
  });
  it('nothing for terminals that cannot draw', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-img2-'));
    writeFileSync(path.join(dir, 'a.png'), png(10, 10));
    expect(inlineImage(path.join(dir, 'a.png'), 'none', 40)).toBeUndefined();
    expect(inlineImage(path.join(dir, 'a.png'), 'iterm', 40)).toMatch(/^\x1b\]1337;File=/);
  });
});

describe('pasted images', () => {
  it('show under your message in fullscreen (kitty), sent to the terminal once', async () => {
    const {vi} = await import('vitest');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-paste-'));
    const file = path.join(dir, 'clipboard-1.png');
    writeFileSync(file, png(200, 100));
    process.env.REIN_GRAPHICS = 'kitty';
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => (writes.push(String(s)), true));
    try {
      const {entryLines} = await import('../src/ui/fullscreen/lines.js');
      const entry = {id: 1, kind: 'user', text: 'what is this? [Image #1]', images: [file]} as const;
      const lines = entryLines(entry as never, 80);
      const placeholders = lines.filter((l) => l.includes(String.fromCodePoint(0x10eeee)));
      expect(placeholders.length).toBeGreaterThan(0);
      entryLines(entry as never, 80); // the screen is redrawn: no second transmit
      expect(writes.filter((w) => w.startsWith('\x1b_G'))).toHaveLength(1);
      expect(writes[0]).toContain('U=1');
    } finally {
      spy.mockRestore();
      delete process.env.REIN_GRAPHICS;
    }
  });
});
