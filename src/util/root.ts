import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

let cached: string | undefined;

/**
 * Rein's package folder (the one with its package.json), found by walking up from this file: the
 * same answer from src/ under tsx, from tsc's dist/ tree and from the single-file dist/cli.js bundle,
 * where a fixed `../..` from import.meta.url would point somewhere else.
 */
export function packageRoot(): string {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    try {
      if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'rein-harness') return (cached = dir);
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) return (cached = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
    dir = up;
  }
}
