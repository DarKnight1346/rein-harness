import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {paths} from '../store/paths.js';

/**
 * MCP pinning (config `mcpPinning`): what a server looked like when you first let it in, its launch
 * config and every tool's name, description and schema, so a server that changes later (a new
 * version, or one that rewrites its tool descriptions to steer the agent) has to be approved again.
 * Kept in ~/.rein/state/mcp-pins.json, as hashes plus tool names.
 */
type Tool = {name: string; description?: string; inputSchema?: unknown};
type Pin = {config: string; tools: string; names: string[]; at: number};

const file = () => path.join(paths.state(), 'mcp-pins.json');
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

function load(): Record<string, Pin> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

/** Sort object keys so the same config or schema always hashes the same. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

export type PinCheck = {kind: 'new'} | {kind: 'same'} | {kind: 'changed'; what: string};

export function checkPin(key: string, config: unknown, tools: Tool[]): PinCheck {
  const pin = load()[key];
  if (!pin) return {kind: 'new'};
  const c = hash(canonical(config));
  const t = hash(canonical([...tools].sort((a, b) => a.name.localeCompare(b.name)).map((x) => [x.name, x.description ?? '', x.inputSchema ?? {}])));
  if (pin.config === c && pin.tools === t) return {kind: 'same'};
  const names = tools.map((x) => x.name);
  const added = names.filter((n) => !pin.names.includes(n));
  const removed = pin.names.filter((n) => !names.includes(n));
  const parts = [
    pin.config !== c && 'its launch config changed',
    added.length && `new tools: ${added.join(', ')}`,
    removed.length && `removed: ${removed.join(', ')}`,
    pin.tools !== t && !added.length && !removed.length && 'tool descriptions or schemas changed',
    pin.tools !== t && (added.length || removed.length) && 'and possibly descriptions or schemas',
  ].filter(Boolean);
  return {kind: 'changed', what: parts.join('; ')};
}

export function pin(key: string, config: unknown, tools: Tool[]): void {
  const all = load();
  all[key] = {
    config: hash(canonical(config)),
    tools: hash(canonical([...tools].sort((a, b) => a.name.localeCompare(b.name)).map((x) => [x.name, x.description ?? '', x.inputSchema ?? {}]))),
    names: tools.map((x) => x.name),
    at: Date.now(),
  };
  mkdirSync(path.dirname(file()), {recursive: true});
  writeFileSync(file(), JSON.stringify(all, null, 1));
}
