import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {decodePng} from '../src/pets/png.js';
import {CELL, framesFromSheet, loadPetFrames, STATES} from '../src/pets/sprite.js';
import {Pets} from '../src/pets/index.js';
import {petTools} from '../src/pets/tools.js';
import {petLines} from '../src/ui/Pet.js';

/** A PNG (RGBA, filter 0) from a pixel function. */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(px(x, y)).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0);
    b.write(t, 4, 'latin1');
    d.copy(b, 8);
    b.writeUInt32BE(crc(Buffer.concat([Buffer.from(t, 'latin1'), d])), 8 + d.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A v1 sheet: in every frame a red square (rows 0–8), in the same place, so the crop is that square. */
const sheet = () => png(CELL.w * 8, CELL.h * 9, (x, y) => (x % CELL.w >= 40 && x % CELL.w < 136 && y % CELL.h >= 50 && y % CELL.h < 146 ? [200, 30, 30, 255] : [0, 0, 0, 0]));

let home: string;
const saved = process.env.REIN_HOME;
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-pets-'));
  process.env.REIN_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.REIN_HOME;
  else process.env.REIN_HOME = saved;
});

describe('pet sprites', () => {
  it('decodes PNG, with every filter row', () => {
    const img = decodePng(png(3, 2, (x, y) => [x * 10, y * 20, 7, x === 2 ? 0 : 255]));
    expect([img.width, img.height]).toEqual([3, 2]);
    expect([...img.data.subarray(4, 8)]).toEqual([10, 0, 7, 255]);
    expect(img.data[(1 * 3 + 2) * 4 + 3]).toBe(0);
  });

  it('crops every frame to the pet and shrinks it to the terminal, two pixels per character', () => {
    const frames = framesFromSheet('test', decodePng(sheet()), 8);
    expect(Object.keys(frames.states)).toEqual(Object.keys(STATES));
    expect(frames.states.idle).toHaveLength(6);
    expect(frames.states.running).toHaveLength(6);
    // The square fills the crop: every pixel is red and opaque.
    expect(frames.w).toBe(8);
    expect(frames.h).toBe(8); // a square pet: 8 pixels wide and tall → 4 character rows
    const f = frames.states.idle[0]!;
    expect(f.px.slice(0, 4)).toEqual([200, 30, 30, 255]);
    const lines = petLines(f);
    expect(lines).toHaveLength(4);
    expect(lines[0]!.replace(/\x1b\[[0-9;]*m/g, '')).toBe('▀'.repeat(8));
  });

  it('refuses something that is not a sprite sheet', () => {
    expect(() => framesFromSheet('x', decodePng(png(10, 10, () => [0, 0, 0, 255])), 8)).toThrow(/not a pet sprite sheet/);
  });

  it('downloads a sheet once and keeps the shrunk frames', async () => {
    let fetched = 0;
    const fetcher = (async () => {
      fetched++;
      return new Response(new Uint8Array(sheet()));
    }) as unknown as typeof fetch;
    const a = await loadPetFrames('dewey', 'https://cdn.example/dewey.png', 8, fetcher);
    const b = await loadPetFrames('dewey', 'https://cdn.example/dewey.png', 8, fetcher);
    expect(a?.states.waving).toHaveLength(4);
    expect(b).toEqual(a);
    expect(fetched).toBe(1);
  });
});

/** The Pets app as Codex serves it, in memory. */
function fakeBridge() {
  const state = {active: 'default'};
  const pets = [
    {id: 'codex', name: 'Codex', description: 'The original Codex companion.', is_custom: false},
    {id: 'hoots', name: 'Hoots', description: 'A sharp-eyed owl.', is_custom: false},
  ];
  const calls: string[] = [];
  return {
    calls,
    state,
    bridge: {
      available: true,
      close() {},
      async tools() {
        return [
          {name: 'pets.list_pets', description: 'List pets', inputSchema: {type: 'object'}, readOnly: true, destructive: false},
          {name: 'pets.select_pet', description: 'Select a pet', inputSchema: {type: 'object'}, readOnly: false, destructive: false},
          {name: 'pets.delete_pet', description: 'Delete a pet', inputSchema: {type: 'object'}, readOnly: false, destructive: true},
        ];
      },
      async call(tool: string, args: any) {
        calls.push(tool);
        if (tool === 'pets.list_pets') {
          // Two pages, like the real one past 20 pets.
          const page = args.cursor ? pets.slice(1) : pets.slice(0, 1);
          return {ok: true, text: '', structured: {pets: page.map((p) => ({...p, is_active: p.id === state.active})), cursor: args.cursor ? null : 'p2', active_pet_id: state.active}};
        }
        if (tool === 'pets.select_pet') {
          state.active = args.pet_id;
          return {ok: true, text: '', structured: {active_pet_id: state.active}};
        }
        if (tool === 'pets.get_pet_download_link') return {ok: true, text: '', structured: {pet_id: args.pet_id, spritesheet_url: `https://cdn.example/${args.pet_id}.png`}};
        return {ok: false, text: `unknown ${tool}`};
      },
    },
  };
}

describe('Pets', () => {
  it('lists every page, picks a pet by name, and says why none is showing', async () => {
    const {bridge, state} = fakeBridge();
    const pets = new Pets(() => true, bridge as any);
    // No Codex account here (REIN_HOME is empty): it says so instead of failing.
    await pets.refresh();
    expect(pets.pet).toBeUndefined();
    expect(pets.note).toMatch(/sign in a Codex account/);
    expect(await pets.list()).toEqual([]);
    writeFileSync(path.join(home, 'accounts.json'), JSON.stringify({version: 1, importOffered: true, accounts: [{id: 'codex-1', provider: 'codex', home: null, imported: true}]}));
    expect((await pets.list()).map((p) => [p.name, p.source])).toEqual([['Codex', 'chatgpt'], ['Hoots', 'chatgpt']]);
    await pets.select('hoo').catch(() => {}); // refresh after selecting needs the account; the selection itself went through
    expect(state.active).toBe('hoots');
    await expect(pets.select('nobody')).rejects.toThrow(/No pet called "nobody"/);
  });

  it("keeps your own pets: adds a sheet, picks up what the create-pet skill finished, shows it without an account", async () => {
    const pets = new Pets(() => true, fakeBridge().bridge as any);
    // A finished create-pet run in a conversation's scratchpad.
    const run = path.join(home, 'scratch', 's1', 'Pets', 'Kernel');
    mkdirSync(path.join(run, 'final'), {recursive: true});
    writeFileSync(path.join(run, 'final', 'spritesheet-extended.png'), sheet());
    writeFileSync(path.join(run, 'pet_request.json'), JSON.stringify({display_name: 'Kernel', description: 'A microchip'}));
    expect(pets.pickUp().map((p) => p.name)).toEqual(['Kernel']);
    expect(pets.pickUp()).toEqual([]); // once
    await pets.refresh();
    expect([pets.pet?.name, pets.pet?.source]).toEqual(['Kernel', 'rein']);
    expect(pets.frames?.states.idle).toHaveLength(6);
    // A sheet of the wrong size isn't a pet.
    const bad = path.join(home, 'bad.png');
    writeFileSync(bad, png(10, 10, () => [0, 0, 0, 255]));
    expect(() => pets.add(bad, 'Bad')).toThrow(/1536×1872/);
    // Another one, then back and forth by name; off hides it.
    const two = path.join(home, 'two.png');
    writeFileSync(two, png(CELL.w * 8, CELL.h * 9, (x, y) => (x % CELL.w > 50 && y % CELL.h > 50 ? [10, 200, 10, 255] : [0, 0, 0, 0])));
    expect(pets.add(two, 'Sprout').name).toBe('Sprout');
    expect(pets.pet?.name).toBe('Sprout');
    await pets.select('kern');
    expect(pets.pet?.name).toBe('Kernel');
    await pets.select('off');
    expect(pets.pet).toBeUndefined();
  }, 30_000); // full-size sheets: slow to encode and decode on a busy machine

  it('turns what the agent does into animations, and settles back to idle', () => {
    const pets = new Pets(() => true, fakeBridge().bridge as any);
    const seen: string[] = [];
    pets.on('state', (s) => seen.push(s));
    pets.setActivity('working');
    pets.setActivity('waiting');
    pets.setActivity('done');
    expect(seen).toEqual(['running', 'waiting', 'review']);
    pets.close();
  });

  it("gives the agent the Pets app's tools: reads run, changes ask, deleting always asks", async () => {
    const {bridge} = fakeBridge();
    const pets = new Pets(() => true, bridge as any);
    const tools = petTools(pets, await bridge.tools());
    expect(tools.map((t) => [t.name, t.mutating, !!t.alwaysAsk])).toEqual([
      ['pets_list_pets', false, false],
      ['pets_select_pet', true, false],
      ['pets_delete_pet', true, true],
    ]);
    const r = await tools[0]!.run({root: '/'} as any, {});
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.text).pets[0].name).toBe('Codex');
  });
});
