import {inflateSync} from 'node:zlib';

/** An image as 8-bit RGBA, row by row. */
export type Rgba = {width: number; height: number; data: Uint8Array};

/**
 * A small PNG decoder (no dependency): 8-bit greyscale, RGB, palette and RGBA, with or without
 * alpha, not interlaced. Enough for pet sprite sheets, which Rein converts to PNG when they come
 * as WebP (see sprite.ts).
 */
export function decodePng(buf: Buffer): Rgba {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') trns = body;
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(type)) throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${type}${interlace ? ', interlaced' : ''})`);
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[type]!;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  // Undo the per-row filters (none, sub, up, average, Paeth).
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels]! : 0;
      const b = y > 0 ? px[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? px[row - stride + x - channels]! : 0;
      const v = raw[src + x]!;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) {
        const e = a + b - c;
        const pa = Math.abs(e - a);
        const pb = Math.abs(e - b);
        const pc = Math.abs(e - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = (v + p) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (type === 6) data.set(px.subarray(s, s + 4), d);
    else if (type === 2) {
      data[d] = px[s]!;
      data[d + 1] = px[s + 1]!;
      data[d + 2] = px[s + 2]!;
      data[d + 3] = 255;
    } else if (type === 3) {
      const k = px[s]!;
      data[d] = palette?.[k * 3] ?? 0;
      data[d + 1] = palette?.[k * 3 + 1] ?? 0;
      data[d + 2] = palette?.[k * 3 + 2] ?? 0;
      data[d + 3] = trns && k < trns.length ? trns[k]! : 255;
    } else {
      data[d] = data[d + 1] = data[d + 2] = px[s]!;
      data[d + 3] = type === 4 ? px[s + 1]! : 255;
    }
  }
  return {width, height, data};
}
