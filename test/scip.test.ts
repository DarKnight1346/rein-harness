import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {buildSymbolGraph, crossRepo, decodeIndex, formatLookup, lookup, shortName, symbolKey} from '../src/system/scip.js';

// A tiny protobuf writer, to make SCIP files the way the indexers do.
const varint = (n: number) => {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const field = (n: number, payload: number[] | string | number): number[] =>
  typeof payload === 'number' ? [...varint(n * 8), ...varint(payload)] : [...varint(n * 8 + 2), ...varint((typeof payload === 'string' ? Buffer.from(payload) : payload).length), ...(typeof payload === 'string' ? [...Buffer.from(payload)] : payload)];
const occurrence = (symbol: string, line: number, roles: number, typed: boolean) =>
  field(2, [...(typed ? field(8, [...field(1, line), ...field(2, 4), ...field(3, 10)]) : field(1, [...varint(line), ...varint(4), ...varint(10)])), ...field(2, symbol), ...(roles ? field(3, roles) : [])]);
const doc = (file: string, occs: number[][], symbols: [string, string][] = []) => field(2, [...field(1, file), ...occs.flat(), ...symbols.flatMap(([s, name]) => field(3, [...field(1, s), ...field(6, name)]))]);

const FORMAT_V1 = 'scip-typescript npm @shop/money 1.0.0 src/`format.ts`/format().';
const FORMAT_V2 = 'scip-typescript npm @shop/money 2.1.0 src/`format.ts`/format().';

function system() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-scip-')));
  const write = (svc: string, bytes: number[]) => {
    mkdirSync(path.join(root, 'services', svc), {recursive: true});
    writeFileSync(path.join(root, 'services', svc, 'package.json'), '{}');
    writeFileSync(path.join(root, 'services', svc, 'index.scip'), Buffer.from(bytes));
  };
  write('money', doc('src/format.ts', [occurrence(FORMAT_V1, 4, 1, true), occurrence('local 3', 5, 0, true)], [[FORMAT_V1, 'format']]));
  write('web', [...doc('src/cart.tsx', [occurrence(FORMAT_V2, 11, 0, false), occurrence(FORMAT_V2, 30, 8, true)]), ...doc('src/x.ts', [])]);
  return root;
}

describe('cross-repo symbol graph (SCIP)', () => {
  it('decodes SCIP documents, occurrences and both range forms', async () => {
    const root = system();
    const {readFileSync} = await import('node:fs');
    expect(decodeIndex(readFileSync(path.join(root, 'services/web/index.scip')))).toEqual([
      {path: 'src/cart.tsx', occurrences: [{symbol: FORMAT_V2, line: 12, roles: 0}, {symbol: FORMAT_V2, line: 31, roles: 8}], symbols: []},
      {path: 'src/x.ts', occurrences: [], symbols: []},
    ]);
    expect(symbolKey(FORMAT_V1)).toBe(symbolKey(FORMAT_V2));
    expect(shortName(FORMAT_V1)).toBe('format');
  });

  it('joins a definition in one repo with its uses in another, whatever the version', () => {
    const g = buildSymbolGraph([{name: 'money', dir: path.join(system(), 'services/money')}].concat([]));
    expect(g.repos).toEqual(['money']);
    const root = system();
    const all = buildSymbolGraph([{name: 'money', dir: path.join(root, 'services/money')}, {name: 'web', dir: path.join(root, 'services/web')}]);
    expect(crossRepo(all)).toEqual([{key: symbolKey(FORMAT_V1), name: 'format', from: 'money', usedIn: ['web']}]);
    expect(formatLookup(lookup(all, 'format'))).toBe(`format  ${symbolKey(FORMAT_V1)}\n  defined  money  src/format.ts:5\n  used     web  src/cart.tsx:12\n  used     web  src/cart.tsx:31`);
    expect(formatLookup(lookup(all, 'nothing'))).toMatch(/^No symbol/);
  });
});
