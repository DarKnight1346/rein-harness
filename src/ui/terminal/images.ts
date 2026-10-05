import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';

/**
 * Images in the terminal, where the terminal can draw them: iTerm2's inline images (iTerm2,
 * WezTerm) and the kitty graphics protocol (kitty, Ghostty). The classic renderer prints them
 * into the scrollback. The fullscreen renderer redraws the whole screen, so there images use
 * kitty's Unicode placeholders: the picture is sent once, then ordinary (special) characters
 * mark where it shows, and the terminal draws it there however often the screen is redrawn.
 */
export type Graphics = 'kitty' | 'iterm' | 'none';

export function detectGraphics(env = process.env): Graphics {
  if (env.REIN_GRAPHICS === 'kitty' || env.REIN_GRAPHICS === 'iterm' || env.REIN_GRAPHICS === 'none') return env.REIN_GRAPHICS;
  if (env.TMUX || /^screen/.test(env.TERM ?? '')) return 'none'; // multiplexers don't pass graphics through by default
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID || env.TERM_PROGRAM === 'ghostty' || env.TERM === 'xterm-ghostty') return 'kitty';
  if (env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2' || env.TERM_PROGRAM === 'WezTerm') return 'iterm';
  return 'none';
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
/** Image files named in a tool result (one per line, as image_generate and read report them). */
export function imagePaths(text: string, root: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const m = /((?:\/|[A-Za-z]:\\|\.{0,2}\/)?[^\s:'"]+\.(?:png|jpe?g|gif|webp))\b/i.exec(raw.trim());
    if (!m) continue;
    const p = path.resolve(root, m[1]!);
    try {
      if (statSync(p).isFile() && IMAGE_EXT.test(p) && !out.includes(p)) out.push(p);
    } catch {}
  }
  return out.slice(0, 4);
}

/** Pixel size of a PNG (from its header), else undefined. */
export function pngSize(data: Buffer): {width: number; height: number} | undefined {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47 || data.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return {width: data.readUInt32BE(16), height: data.readUInt32BE(20)};
}

/** Cells an image takes at most `maxCols` wide (cells are about twice as tall as wide). */
export function cellsFor(px: {width: number; height: number}, maxCols: number, maxRows: number): {cols: number; rows: number} {
  let cols = Math.max(1, Math.min(maxCols, Math.ceil(px.width / 10)));
  let rows = Math.max(1, Math.round((cols * px.height) / px.width / 2));
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.max(1, Math.round((rows * 2 * px.width) / px.height));
  }
  return {cols, rows};
}

/** iTerm2 / WezTerm inline image, `cols` cells wide (any format the terminal reads). */
export function itermImage(data: Buffer, cols: number): string {
  return `\x1b]1337;File=inline=1;size=${data.length};width=${cols};preserveAspectRatio=1:${data.toString('base64')}\x07`;
}

/** kitty graphics: transmit (and, without `virtual`, display) a PNG, in 4 KB chunks. `virtual`: for Unicode placeholders. */
export function kittyImage(png: Buffer, cols: number, rows: number, opts: {id?: number; virtual?: boolean} = {}): string {
  const b64 = png.toString('base64');
  const head = `a=T,f=100,q=2,c=${cols},r=${rows}${opts.id ? `,i=${opts.id}` : ''}${opts.virtual ? ',U=1' : ''}`;
  let out = '';
  for (let i = 0; i < b64.length; i += 4096) {
    const last = i + 4096 >= b64.length;
    out += `\x1b_G${i === 0 ? `${head},` : ''}m=${last ? 0 : 1};${b64.slice(i, i + 4096)}\x1b\\`;
  }
  return out;
}

/** kitty's row/column diacritics for Unicode placeholders (gen/rowcolumn-diacritics.txt). */
const DIACRITICS = '0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357 035B 0363 0364 0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484 0485 0486 0487 0592 0593 0594 0595 0597 0598 0599 059C 059D 059E 059F 05A0 05A1 05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612 0613 0614 0615 0616 0617 0657 0658 0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC 06DF 06E0 06E1 06E2 06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741 0743 0745 0747 0749 074A 07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819 081B 081C 081D 081E 081F 0820 0821 0822 0823 0825 0826 0827 0829 082A 082B 082C 082D 0951 0953 0954 0F82 0F83 0F86 0F87 135D 135E 135F 17DD 193A 1A17 1A75 1A76 1A77 1A78 1A79 1A7A 1A7B 1A7C 1B6B 1B6D 1B6E 1B6F 1B70 1B71 1B72 1B73 1CD0 1CD1 1CD2 1CDA 1CDB 1CE0 1DC0 1DC1 1DC3 1DC4 1DC5 1DC6 1DC7 1DC8 1DC9 1DCB 1DCC 1DD1 1DD2 1DD3 1DD4 1DD5 1DD6 1DD7 1DD8 1DD9 1DDA 1DDB 1DDC 1DDD 1DDE 1DDF 1DE0 1DE1 1DE2 1DE3 1DE4 1DE5 1DE6 1DFE 20D0 20D1 20D4 20D5 20D6 20D7 20DB 20DC 20E1 20E7 20E9 20F0 2CEF 2CF0 2CF1 2DE0 2DE1 2DE2 2DE3 2DE4 2DE5 2DE6 2DE7 2DE8 2DE9 2DEA 2DEB 2DEC 2DED 2DEE 2DEF 2DF0 2DF1 2DF2 2DF3 2DF4 2DF5 2DF6 2DF7 2DF8 2DF9 2DFA 2DFB 2DFC 2DFD 2DFE 2DFF A66F A67C A67D A6F0 A6F1 A8E0 A8E1 A8E2 A8E3 A8E4 A8E5 A8E6 A8E7 A8E8 A8E9 A8EA A8EB A8EC A8ED A8EE A8EF A8F0 A8F1 AAB0 AAB2 AAB3 AAB7 AAB8 AABE AABF AAC1 FE20 FE21 FE22 FE23 FE24 FE25 FE26 10A0F 10A38 1D185 1D186 1D187 1D188 1D189 1D1AA 1D1AB 1D1AC 1D1AD 1D242 1D243 1D244'.split(' ').map((h) => String.fromCodePoint(parseInt(h, 16)));
const PLACEHOLDER = String.fromCodePoint(0x10eeee);

/** The text that shows image `id` (`rows` lines of `cols` cells): its foreground color carries the id. */
export function kittyPlaceholder(id: number, cols: number, rows: number): string[] {
  const color = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
  const lines: string[] = [];
  for (let r = 0; r < Math.min(rows, DIACRITICS.length); r++) {
    let line = color;
    for (let c = 0; c < Math.min(cols, DIACRITICS.length); c++) line += PLACEHOLDER + DIACRITICS[r] + DIACRITICS[c];
    lines.push(line + '\x1b[39m');
  }
  return lines;
}

/** An image for the classic renderer's scrollback (undefined: the terminal can't draw it). */
export function inlineImage(file: string, g: Graphics, maxCols: number): string | undefined {
  if (g === 'none') return undefined;
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch {
    return undefined;
  }
  if (data.length > 8 * 1024 * 1024) return undefined;
  const size = pngSize(data);
  const {cols, rows} = cellsFor(size ?? {width: 800, height: 600}, maxCols, 30);
  if (g === 'iterm') return itermImage(data, cols) + '\n';
  if (!size) return undefined; // kitty's direct transmit here is PNG only
  return kittyImage(data, cols, rows) + '\n';
}
