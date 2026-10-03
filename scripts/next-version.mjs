#!/usr/bin/env node
// Next version to publish: one patch past the latest on npm, unless package.json's version is
// already higher (a manual minor/major bump), in which case that version is used as-is.
// Usage: node scripts/next-version.mjs <package.json version> [latest npm version]

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(String(v ?? '').trim());
  return m ? {major: +m[1], minor: +m[2], patch: +m[3], pre: m[4]} : undefined;
};

export function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  return a.pre === undefined ? 1 : b.pre === undefined ? -1 : a.pre.localeCompare(b.pre);
}

export function nextVersion(base, latest) {
  const b = parse(base);
  if (!b) throw new Error(`invalid package.json version: ${base}`);
  const l = parse(latest);
  if (!l || compare(b, l) > 0) return `${b.major}.${b.minor}.${b.patch}${b.pre ? `-${b.pre}` : ''}`;
  return `${l.major}.${l.minor}.${l.patch + (l.pre ? 0 : 1)}`;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(nextVersion(process.argv[2], process.argv[3]));
