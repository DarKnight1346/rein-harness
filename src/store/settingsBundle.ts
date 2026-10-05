import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reinConfigDir} from './paths.js';

/**
 * Your settings as one file, to set up another machine the same way: config, permission rules
 * and hooks, MCP servers, global instructions, skills and agents. Never accounts, logins, the
 * vault or keys; secret-looking values written literally into MCP server configs are left out
 * (`${VAR}` references stay, so they work wherever the variable is set).
 */
export const BUNDLE_FILES = ['config.json', 'settings.json', 'mcp.json', 'AGENTS.md', 'system-prompt.md'];
export const BUNDLE_DIRS = ['skills', 'agents'];
const MAX_FILE = 1024 * 1024;

export type Bundle = {rein: 'settings'; version: 1; exportedAt: string; files: Record<string, string>; redacted: string[]};

/** Keep `${VAR}` references; anything else in env / headers might be a secret. */
function redactMcp(json: string, redacted: string[]): string {
  try {
    const cfg = JSON.parse(json) as {mcpServers?: Record<string, {env?: Record<string, string>; headers?: Record<string, string>}>};
    for (const [name, s] of Object.entries(cfg.mcpServers ?? {})) {
      for (const field of ['env', 'headers'] as const) {
        for (const [k, v] of Object.entries(s[field] ?? {})) {
          if (typeof v === 'string' && !/^\$\{\w+(:-[^}]*)?\}$/.test(v.trim())) {
            s[field]![k] = '<set this on the new machine>';
            redacted.push(`mcp.json: ${name}.${field}.${k}`);
          }
        }
      }
    }
    return JSON.stringify(cfg, null, 2) + '\n';
  } catch {
    return json;
  }
}

function walk(dir: string, rel: string, out: Record<string, string>): void {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(p, r, out);
    else if (e.isFile() && statSync(p).size <= MAX_FILE) out[r] = readFileSync(p, 'utf8');
  }
}

export function exportSettings(dir = reinConfigDir()): Bundle {
  const files: Record<string, string> = {};
  const redacted: string[] = [];
  for (const f of BUNDLE_FILES) {
    const p = path.join(dir, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    files[f] = f === 'mcp.json' ? redactMcp(text, redacted) : text;
  }
  for (const d of BUNDLE_DIRS) if (existsSync(path.join(dir, d))) walk(path.join(dir, d), d, files);
  return {rein: 'settings', version: 1, exportedAt: new Date().toISOString(), files, redacted};
}

export function writeBundle(file: string, b: Bundle): string {
  const out = path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
  writeFileSync(out, JSON.stringify(b, null, 2) + '\n', {mode: 0o600});
  return out;
}

/**
 * Write a bundle's files into this machine's settings. Files that exist and differ are kept as
 * `<name>.before-import` first. Paths outside the settings folder are refused.
 */
export function importSettings(file: string, dir = reinConfigDir()): {written: string[]; backedUp: string[]} {
  const b = JSON.parse(readFileSync(path.resolve(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file), 'utf8')) as Bundle;
  if (b?.rein !== 'settings' || typeof b.files !== 'object') throw new Error("that isn't a Rein settings file (from /settings export)");
  const written: string[] = [];
  const backedUp: string[] = [];
  for (const [rel, text] of Object.entries(b.files)) {
    const top = rel.split('/')[0]!;
    if (!(BUNDLE_FILES.includes(rel) || BUNDLE_DIRS.includes(top)) || rel.split('/').includes('..') || path.isAbsolute(rel)) continue;
    const dest = path.join(dir, rel);
    if (!dest.startsWith(path.resolve(dir) + path.sep)) continue;
    mkdirSync(path.dirname(dest), {recursive: true});
    if (existsSync(dest) && readFileSync(dest, 'utf8') !== text) {
      copyFileSync(dest, `${dest}.before-import`);
      backedUp.push(rel);
    }
    writeFileSync(dest, text);
    written.push(rel);
  }
  return {written, backedUp};
}
