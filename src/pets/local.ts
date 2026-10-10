import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {reinHome} from '../store/paths.js';
import {petsDir} from './sprite.js';

/**
 * Rein's own pets: sprite sheets kept on this machine, no account needed. Add one with `/pet add
 * <sheet>`, or let Rein pick up what the create-pet skill finishes (a `Pets/<Name>/final/` folder
 * in a conversation's scratchpad, with its `pet_request.json`). Which pet is showing, yours or your
 * ChatGPT one, is kept in ~/.rein/pets/active.json.
 */
export type LocalPet = {id: string; name: string; description: string; sheet: string; addedAt: number; from?: string};
export type Active = {source: 'rein' | 'chatgpt'; id?: string} | {source: 'off'};

export const minePath = () => path.join(petsDir(), 'mine');
const activeFile = () => path.join(petsDir(), 'active.json');
const readJson = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Which pet shows: yours, your ChatGPT one (the default), or none. */
export function activePet(): Active {
  const a = readJson(activeFile());
  return a?.source === 'rein' || a?.source === 'off' ? a : {source: 'chatgpt'};
}
export function setActivePet(a: Active): void {
  mkdirSync(petsDir(), {recursive: true});
  writeFileSync(activeFile(), JSON.stringify(a) + '\n');
}

export function localPets(): LocalPet[] {
  const dir = minePath();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((d) => readJson(path.join(dir, d, 'pet.json')) as LocalPet | undefined)
    .filter((p): p is LocalPet => !!p && existsSync(p.sheet))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A PNG's size from its header (no decoding). */
function pngSize(file: string): {w: number; h: number} | undefined {
  const b = readFileSync(file).subarray(0, 24);
  return b.readUInt32BE(0) === 0x89504e47 ? {w: b.readUInt32BE(16), h: b.readUInt32BE(20)} : undefined;
}

/** Why a file can't be a pet's sprite sheet (undefined: it can). */
export function sheetProblem(file: string): string | undefined {
  if (!existsSync(file)) return `${file} doesn't exist`;
  const s = pngSize(file);
  if (!s) return 'a sprite sheet must be a PNG';
  if (s.w !== 1536 || (s.h !== 1872 && s.h !== 2288)) return `a sprite sheet is 1536×1872 (v1) or 1536×2288 (v2); this one is ${s.w}×${s.h}`;
  return undefined;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pet';

/** Add a sprite sheet as one of your pets (same bytes again: the pet you already have). */
export function addLocalPet(sheet: string, name: string, description = '', from?: string): LocalPet {
  const problem = sheetProblem(sheet);
  if (problem) throw new Error(problem);
  const hash = createHash('sha256').update(readFileSync(sheet)).digest('hex').slice(0, 12);
  const same = localPets().find((p) => p.sheet.includes(hash));
  if (same) return same;
  let id = slug(name);
  for (let n = 2; existsSync(path.join(minePath(), id)); n++) id = `${slug(name)}-${n}`;
  const dir = path.join(minePath(), id);
  mkdirSync(dir, {recursive: true});
  const dest = path.join(dir, `spritesheet-${hash}.png`);
  copyFileSync(sheet, dest);
  const pet: LocalPet = {id, name, description, sheet: dest, addedAt: Date.now(), ...(from ? {from} : {})};
  writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(pet, null, 2) + '\n');
  return pet;
}

/** The best sheet in a create-pet run's final/ folder: the extended (v2) one, else the plain one. */
function finishedSheet(petDir: string): string | undefined {
  const final = path.join(petDir, 'final');
  for (const f of ['spritesheet-extended.png', 'spritesheet.png']) {
    const p = path.join(final, f);
    if (existsSync(p) && !sheetProblem(p)) return p;
  }
  return undefined;
}

/**
 * Pets the create-pet skill finished in a conversation's scratchpad (Pets/<Name>/final/), added as
 * your pets. Returns the new ones. Each sheet is added once (by its bytes).
 */
export function pickUpFinished(scratchRoot = path.join(reinHome(), 'scratch')): LocalPet[] {
  const added: LocalPet[] = [];
  const known = new Set(localPets().map((p) => p.from).filter(Boolean));
  let sessions: string[] = [];
  try {
    sessions = readdirSync(scratchRoot);
  } catch {
    return added;
  }
  for (const s of sessions) {
    const petsRoot = path.join(scratchRoot, s, 'Pets');
    let names: string[] = [];
    try {
      names = readdirSync(petsRoot).filter((n) => statSync(path.join(petsRoot, n)).isDirectory());
    } catch {
      continue;
    }
    for (const n of names) {
      const sheet = finishedSheet(path.join(petsRoot, n));
      if (!sheet || known.has(sheet)) continue;
      const req = readJson(path.join(petsRoot, n, 'pet_request.json')) ?? {};
      const before = localPets().length;
      const pet = addLocalPet(sheet, String(req.display_name ?? req.name ?? n), String(req.description ?? ''), sheet);
      if (localPets().length > before) added.push(pet);
    }
  }
  return added;
}
