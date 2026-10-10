import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {reinHome} from '../store/paths.js';
import {run} from '../util/proc.js';
import {decodePng, type Rgba} from './png.js';

/**
 * Pet sprite sheets, as the ChatGPT and Codex apps use them: 192×208 cells, eight columns, one row
 * per animation state (v1: nine rows; v2 adds two rows of look directions). Rein shrinks each frame
 * to a small grid of pixels for the terminal (two per character cell: ▀ with a foreground and a
 * background colour), cropped to the pet's own outline across every frame.
 */
export const CELL = {w: 192, h: 208};
/** Rows and their frame counts (sprite-sheet contract). */
export const STATES = {idle: [0, 6], 'running-right': [1, 8], 'running-left': [2, 8], waving: [3, 4], jumping: [4, 5], failed: [5, 8], waiting: [6, 6], running: [7, 6], review: [8, 6]} as const;
export type PetState = keyof typeof STATES;

/** A shrunk frame: `w`×`h` pixels, RGBA (alpha 0 or 255). */
export type Frame = {w: number; h: number; px: number[]};
export type PetFrames = {id: string; w: number; h: number; states: Record<PetState, Frame[]>};

export const petsDir = () => path.join(reinHome(), 'pets');

/** The sheet as PNG bytes: WebP is converted with whatever this machine has (none: undefined). */
async function asPng(file: string): Promise<Buffer | undefined> {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) === 0x89504e47) return buf;
  const out = path.join(os.tmpdir(), `rein-pet-${process.pid}-${Date.now()}.png`);
  const tools: [string, string[]][] = [
    ['sips', ['-s', 'format', 'png', file, '--out', out]], // macOS
    ['dwebp', [file, '-o', out]], // libwebp
    ['magick', [file, out]],
    ['convert', [file, out]],
    ['ffmpeg', ['-loglevel', 'error', '-y', '-i', file, out]],
  ];
  try {
    for (const [cmd, args] of tools) {
      const r = await run(cmd, args, {timeoutMs: 60_000}).catch(() => undefined);
      if (r?.code === 0 && existsSync(out)) return readFileSync(out);
    }
    return undefined;
  } finally {
    rmSync(out, {force: true});
  }
}

/** Average a source block into one pixel; transparent when less than half of it is covered. */
function sample(img: Rgba, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let n = 0;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const i = (y * img.width + x) * 4;
      const al = img.data[i + 3]!;
      r += img.data[i]! * al;
      g += img.data[i + 1]! * al;
      b += img.data[i + 2]! * al;
      a += al;
      n++;
    }
  if (!n || a / n < 128) return [0, 0, 0, 0];
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a), 255];
}

/** Every state's frames from a decoded sheet, `width` pixels wide (height keeps the pet's shape). */
export function framesFromSheet(id: string, img: Rgba, width: number): PetFrames {
  if (img.width !== CELL.w * 8 || img.height < CELL.h * 9) throw new Error(`not a pet sprite sheet (${img.width}×${img.height}; expected 1536 wide and at least 1872 tall)`);
  // The pet's outline across every frame of every state: crop to it so the few pixels go to the pet.
  let minX = CELL.w;
  let minY = CELL.h;
  let maxX = 0;
  let maxY = 0;
  for (const [row, count] of Object.values(STATES))
    for (let f = 0; f < count; f++)
      for (let y = 0; y < CELL.h; y++)
        for (let x = 0; x < CELL.w; x++) {
          if (img.data[((row * CELL.h + y) * img.width + f * CELL.w + x) * 4 + 3]! < 128) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
  if (maxX < minX) throw new Error('the sprite sheet is empty');
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const w = width;
  // Two pixels per character row and cells about twice as tall as wide: a pixel is about square.
  const h = Math.max(2, Math.round((bh / bw) * w / 2) * 2);
  const states = {} as Record<PetState, Frame[]>;
  for (const [name, [row, count]] of Object.entries(STATES) as [PetState, readonly [number, number]][]) {
    states[name] = [];
    for (let f = 0; f < count; f++) {
      const px: number[] = [];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = f * CELL.w + minX + (x * bw) / w;
          const sy = row * CELL.h + minY + (y * bh) / h;
          px.push(...sample(img, sx, sy, sx + bw / w, sy + bh / h));
        }
      states[name].push({w, h, px});
    }
  }
  return {id, w, h, states};
}

/**
 * The frames of a pet at `width`, from its sheet at `url` (downloaded once; built-in pets have
 * fixed URLs, custom ones short-lived URLs, so the cache is keyed by the pet and its sheet bytes).
 * Undefined when the sheet is WebP and nothing here can convert it.
 */
export async function loadPetFrames(id: string, url: string, width: number, fetcher: typeof fetch = fetch): Promise<PetFrames | undefined> {
  const dir = petsDir();
  mkdirSync(dir, {recursive: true});
  const safe = id.replace(/[^\w-]/g, '_');
  const sheetFile = path.join(dir, `${safe}.sheet`);
  if (!existsSync(sheetFile)) {
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`couldn't download the sprite sheet (HTTP ${res.status})`);
    writeFileSync(sheetFile, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = readFileSync(sheetFile);
  const key = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const cached = path.join(dir, `${safe}-${key}-${width}.json`);
  if (existsSync(cached)) {
    try {
      return JSON.parse(readFileSync(cached, 'utf8')) as PetFrames;
    } catch {}
  }
  const png = await asPng(sheetFile);
  if (!png) return undefined;
  const frames = framesFromSheet(id, decodePng(png), width);
  writeFileSync(cached, JSON.stringify(frames));
  return frames;
}

/** Forget a pet's downloaded sheet (its artwork changed). */
export function forgetPet(id: string): void {
  rmSync(path.join(petsDir(), `${id.replace(/[^\w-]/g, '_')}.sheet`), {force: true});
}
