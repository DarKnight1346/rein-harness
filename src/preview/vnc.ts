import {EventEmitter} from 'node:events';
import net from 'node:net';
import {encodePng} from './png.js';
import type {InputEvent} from './cdp.js';

/**
 * A display preview: a VNC (RFB) client in Rein, for anything with a screen. QEMU (`-vnc :1`), an
 * app in a virtual display (Xvfb + x11vnc), an emulator, a desktop's screen sharing. Rein keeps the
 * framebuffer and sends what changed as PNG patches over the same channel as everything else, so
 * the page needs no VNC code and no extra connection. Raw, CopyRect and DesktopSize encodings; no
 * password (VNC's DES challenge isn't supported yet: a server that asks for one says so).
 */
export type Patch = {x: number; y: number; w: number; h: number; png: string; width: number; height: number; full?: boolean};

class Reader {
  private chunks: Buffer[] = [];
  private have = 0;
  private waiting: {n: number; resolve(b: Buffer): void} | undefined;
  closed = false;
  push(b: Buffer): void {
    this.chunks.push(b);
    this.have += b.length;
    this.flush();
  }
  end(): void {
    this.closed = true;
    this.waiting?.resolve(Buffer.alloc(0));
  }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve) => {
      this.waiting = {n, resolve};
      this.flush();
    });
  }
  private flush(): void {
    const w = this.waiting;
    if (!w || this.have < w.n) return;
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const out = all.subarray(0, w.n);
    const rest = all.subarray(w.n);
    this.chunks = rest.length ? [rest] : [];
    this.have = rest.length;
    this.waiting = undefined;
    w.resolve(Buffer.from(out));
  }
}

export class VncView extends EventEmitter {
  private sock: net.Socket | undefined;
  private reader = new Reader();
  private fb = new Uint8Array(0);
  width = 0;
  height = 0;
  name = '';
  private buttons = 0;
  private streaming = true;
  private lastFull = 0;
  closed = false;

  async start(target: string): Promise<void> {
    const m = target.match(/^\[?([^\]]+?)\]?:(\d+)$/);
    if (!m) throw new Error(`not a VNC address: ${target}`);
    this.sock = net.connect({host: m[1], port: Number(m[2])});
    await new Promise<void>((resolve, reject) => {
      this.sock!.once('connect', () => resolve());
      this.sock!.once('error', (err) => reject(new Error(`couldn't reach ${target}: ${err.message}`)));
    });
    this.sock.on('data', (d: Buffer) => this.reader.push(d));
    this.sock.on('close', () => (this.reader.end(), this.close()));
    this.sock.on('error', () => this.close());
    await this.handshake();
    void this.loop().catch((err) => {
      if (!this.closed) this.emit('notice', `The display connection ended: ${(err as Error).message}`);
      this.close();
    });
  }

  private async need(n: number): Promise<Buffer> {
    const b = await this.reader.read(n);
    if (b.length < n) throw new Error('the server closed the connection');
    return b;
  }

  private async handshake(): Promise<void> {
    const ver = (await this.need(12)).toString('latin1');
    const minor = Number(ver.match(/^RFB 003\.(\d{3})/)?.[1] ?? 3);
    const use = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
    this.sock!.write(`RFB 003.00${use}\n`);
    let type: number;
    if (use === 3) type = (await this.need(4)).readUInt32BE(0);
    else {
      const n = (await this.need(1))[0]!;
      if (!n) throw new Error(await this.reason());
      const types = [...(await this.need(n))];
      if (!types.includes(1)) throw new Error(types.includes(2) ? 'the display asks for a VNC password, which Rein can’t answer yet: start it without one (QEMU: -vnc :1)' : `no security type Rein supports (offered: ${types.join(', ')})`);
      type = 1;
      this.sock!.write(Buffer.from([1]));
    }
    if (type === 0) throw new Error(await this.reason());
    if (type !== 1) throw new Error('the display asks for a VNC password, which Rein can’t answer yet');
    if (use === 8 && (await this.need(4)).readUInt32BE(0) !== 0) throw new Error(await this.reason());
    this.sock!.write(Buffer.from([1])); // ClientInit: shared
    const init = await this.need(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    this.name = (await this.need(init.readUInt32BE(20))).toString('utf8');
    this.fb = new Uint8Array(this.width * this.height * 4);
    // 32 bits a pixel, little-endian 0x00RRGGBB (bytes B, G, R, 0).
    const pf = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
    this.sock!.write(pf);
    const enc = Buffer.alloc(4 + 3 * 4);
    enc.writeUInt8(2, 0);
    enc.writeUInt16BE(3, 2);
    [1, 0, -223].forEach((e, i) => enc.writeInt32BE(e, 4 + i * 4)); // CopyRect, Raw, DesktopSize
    this.sock!.write(enc);
    this.request(false);
  }

  private async reason(): Promise<string> {
    const len = (await this.reader.read(4)).readUInt32BE?.(0) ?? 0;
    return len ? (await this.need(len)).toString('utf8') : 'the display refused the connection';
  }

  private request(incremental: boolean): void {
    const b = Buffer.alloc(10);
    b[0] = 3;
    b[1] = incremental ? 1 : 0;
    b.writeUInt16BE(this.width, 6);
    b.writeUInt16BE(this.height, 8);
    this.sock?.write(b);
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      const type = (await this.need(1))[0]!;
      if (type === 0) await this.update();
      else if (type === 1) {
        const h = await this.need(5);
        await this.need(h.readUInt16BE(3) * 6);
      } else if (type === 2) this.emit('notice', 'The display rang its bell.');
      else if (type === 3) {
        const h = await this.need(7);
        await this.need(h.readUInt32BE(3));
      } else throw new Error(`unknown message ${type} from the server`);
    }
  }

  private async update(): Promise<void> {
    const n = (await this.need(3)).readUInt16BE(1);
    let x0 = Infinity, y0 = Infinity, x1 = 0, y1 = 0;
    let resized = false;
    for (let i = 0; i < n; i++) {
      const r = await this.need(12);
      const x = r.readUInt16BE(0), y = r.readUInt16BE(2), w = r.readUInt16BE(4), h = r.readUInt16BE(6);
      const enc = r.readInt32BE(8);
      if (enc === 0) {
        const px = await this.need(w * h * 4);
        for (let row = 0; row < h; row++) {
          let d = ((y + row) * this.width + x) * 4;
          let s = row * w * 4;
          for (let col = 0; col < w; col++, d += 4, s += 4) {
            this.fb[d] = px[s + 2]!;
            this.fb[d + 1] = px[s + 1]!;
            this.fb[d + 2] = px[s]!;
            this.fb[d + 3] = 255;
          }
        }
      } else if (enc === 1) {
        const src = await this.need(4);
        const sx = src.readUInt16BE(0), sy = src.readUInt16BE(2);
        const copy = new Uint8Array(w * h * 4);
        for (let row = 0; row < h; row++) copy.set(this.fb.subarray(((sy + row) * this.width + sx) * 4, ((sy + row) * this.width + sx + w) * 4), row * w * 4);
        for (let row = 0; row < h; row++) this.fb.set(copy.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * this.width + x) * 4);
      } else if (enc === -223) {
        this.width = w;
        this.height = h;
        this.fb = new Uint8Array(w * h * 4);
        resized = true;
        continue;
      } else throw new Error(`unsupported encoding ${enc}`);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w);
      y1 = Math.max(y1, y + h);
    }
    if (resized) {
      this.request(false);
      return;
    }
    if (x1 > x0 && y1 > y0 && this.streaming) this.patch(x0, y0, x1 - x0, y1 - y0);
    // ~15 updates a second at most.
    setTimeout(() => this.streaming && !this.closed && this.request(true), 66).unref();
  }

  private patch(x: number, y: number, w: number, h: number, full = false): void {
    this.emit('patch', {x, y, w, h, png: encodePng(this.fb, this.width, x, y, w, h).toString('base64'), width: this.width, height: this.height, ...(full ? {full: true} : {})} satisfies Patch);
  }

  /** The whole screen (a page that just connected needs it). */
  full(): void {
    if (this.width && this.height && Date.now() - this.lastFull > 200) {
      this.lastFull = Date.now();
      this.patch(0, 0, this.width, this.height, true);
    }
  }

  stream(on: boolean): void {
    if (on === this.streaming) return;
    this.streaming = on;
    if (on) {
      this.full();
      this.request(true);
    }
  }

  input(ev: InputEvent): void {
    const s = this.sock;
    if (!s || this.closed) return;
    const pointer = (mask: number, x: number, y: number) => {
      const b = Buffer.alloc(6);
      b[0] = 5;
      b[1] = mask;
      b.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
      b.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
      s.write(b);
    };
    if (ev.type === 'mouse') {
      const bit = ev.button === 'right' ? 4 : ev.button === 'middle' ? 2 : 1;
      if (ev.action === 'down') this.buttons |= bit;
      else if (ev.action === 'up') this.buttons &= ~bit;
      pointer(this.buttons, ev.x, ev.y);
    } else if (ev.type === 'wheel') {
      const bit = ev.dy < 0 ? 8 : ev.dy > 0 ? 16 : ev.dx < 0 ? 32 : 64;
      pointer(this.buttons | bit, ev.x, ev.y);
      pointer(this.buttons, ev.x, ev.y);
    } else if (ev.type === 'key') {
      const sym = keysym(ev.key);
      if (!sym) return;
      const b = Buffer.alloc(8);
      b[0] = 4;
      b[1] = ev.action === 'down' ? 1 : 0;
      b.writeUInt32BE(sym, 4);
      s.write(b);
    } else if (ev.type === 'text') {
      for (const ch of ev.text) for (const down of [1, 0]) {
        const b = Buffer.alloc(8);
        b[0] = 4;
        b[1] = down;
        b.writeUInt32BE(keysym(ch), 4);
        s.write(b);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sock?.destroy();
    this.emit('closed');
  }
}

/** X keysyms for the browser's key names (VNC sends keysyms, not characters). */
export function keysym(key: string): number {
  const named: Record<string, number> = {
    Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff, Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
    PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63, Shift: 0xffe1, Control: 0xffe3, Alt: 0xffe9, Meta: 0xffe7, CapsLock: 0xffe5,
  };
  if (named[key]) return named[key]!;
  const f = key.match(/^F(\d{1,2})$/);
  if (f) return 0xffbd + Number(f[1]);
  const cp = [...key].length === 1 ? key.codePointAt(0)! : 0;
  if (!cp) return 0;
  return cp < 0x100 ? cp : 0x01000000 + cp;
}
