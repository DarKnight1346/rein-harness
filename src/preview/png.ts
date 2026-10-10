import {deflateSync} from 'node:zlib';

/**
 * A region of an RGBA framebuffer as a PNG, for the VNC preview's patches. Node has zlib, so no
 * image library is needed: filter 0 per row, deflated, with the three required chunks.
 */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** `rgba`: the whole framebuffer (fbWidth wide, 4 bytes a pixel); the region x,y,w,h is encoded (opaque RGB). */
export function encodePng(rgba: Uint8Array, fbWidth: number, x: number, y: number, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let row = 0; row < h; row++) {
    const out = row * (w * 3 + 1);
    raw[out] = 0;
    let src = ((y + row) * fbWidth + x) * 4;
    for (let col = 0, o = out + 1; col < w; col++, src += 4, o += 3) {
      raw[o] = rgba[src]!;
      raw[o + 1] = rgba[src + 1]!;
      raw[o + 2] = rgba[src + 2]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, {level: 3})), chunk('IEND', Buffer.alloc(0))]);
}
