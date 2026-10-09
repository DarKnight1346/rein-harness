import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {DECLARATION, ripgrep} from '../tools/fs.js';
import {run} from '../util/proc.js';

/**
 * A repo map (/map, experiment repo-map): each source file's top-level declarations, one line each,
 * as much as fits in a token budget, so the agent knows where things are without reading files.
 * Files are ranked by how much they export, then by depth (shallow first); tests, vendored and
 * generated files are left out.
 */
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|scala|swift|rb|php|cs|fs|c|cc|cpp|cxx|h|hh|hpp|m|mm|ex|exs|erl|hs|ml|clj|dart|lua|r|jl|sol|zig|nim|vue|svelte)$/i;
const SKIP = /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|target|\.next|coverage|__generated__|generated|gen)\/|(?:\.min\.|\.d\.ts$|_pb2?\.|\.pb\.go$|\.g\.dart$)|(?:^|\/)(?:tests?|__tests__|spec|testdata|fixtures)\/|(?:[._-](?:test|spec))\.[a-z]+$/i;
const EXPORTED = /^\s*(?:export\b|pub\b|public\b|def [^_]|func [A-Z]|class |interface |type |struct |trait |module |object )/;
const MAX_FILES = 5000;
const MAX_BYTES = 400_000;

type Entry = {file: string; decls: string[]; exported: number; depth: number};

/** Top-level declarations of one file's text (signature lines, trimmed). */
export function declarations(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s/.test(line) || !DECLARATION.test(line) || /^(?:\/\/|\/\*|\*|#(?!#* )|--|;|import\b|from\b|use\b|package\b|require\b)/.test(line)) continue;
    // A signature, not its body: drop `{ … }` on a function, class or type line (a const's value stays).
    const sig = /\b(?:function|class|interface|struct|impl|trait|enum|fn|func|def|module|namespace|object)\b/.test(line) ? line.replace(/\s*\{.*$/, '') : line;
    out.push(sig.replace(/\s*[{:]?\s*$/, '').replace(/\s+/g, ' ').slice(0, 140));
  }
  return out;
}

export async function repoMap(root: string, budgetTokens = 4000): Promise<{text: string; files: number; shown: number}> {
  const rg = await ripgrep();
  const listed = rg ? ((await run(rg, ['--files', '--color', 'never'], {cwd: root, timeoutMs: 30_000}).catch(() => undefined))?.stdout ?? '') : '';
  const files = listed.split(/\r?\n/).map((f) => f.replace(/\\/g, '/')).filter((f) => f && SOURCE.test(f) && !SKIP.test(f)).slice(0, MAX_FILES);
  const entries: Entry[] = [];
  for (const file of files) {
    let text = '';
    try {
      if (statSync(path.join(root, file)).size > MAX_BYTES) continue;
      text = readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const decls = declarations(text);
    if (decls.length) entries.push({file, decls, exported: decls.filter((d) => EXPORTED.test(d)).length, depth: file.split('/').length});
  }
  entries.sort((a, b) => b.exported - a.exported || a.depth - b.depth || a.file.localeCompare(b.file));
  const budget = budgetTokens * 4;
  const parts: string[] = [];
  let used = 0;
  for (const e of entries) {
    const block = `${e.file}\n${e.decls.slice(0, 25).map((d) => `  ${d}`).join('\n')}${e.decls.length > 25 ? `\n  … ${e.decls.length - 25} more` : ''}`;
    if (used + block.length > budget) continue;
    parts.push(block);
    used += block.length + 1;
  }
  return {text: parts.sort().join('\n'), files: entries.length, shown: parts.length};
}

/** `repo_map` (experiment repo-map): the map, for the agent to find its way in a big repo. */
export function repoMapTool(experiments: () => string[]): import('../tools/registry.js').ToolDef {
  return {
    name: 'repo_map',
    label: 'RepoMap',
    description: "A map of the repo: each source file's top-level declarations (functions, classes, types), as much as fits in budget_tokens. Use it first in a large unfamiliar codebase to see where things are, then read only the files you need. path narrows it to one folder.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {type: 'string', description: 'A folder to map, relative to the project (default: the whole project)'},
        budget_tokens: {type: 'integer', description: 'Size of the map (default 4000, at most 20000)'},
      },
    },
    mutating: false,
    enabled: () => experiments().includes('repo-map'),
    summarize: (a) => String(a?.path ?? '.'),
    async run(ctx, args) {
      const dir = typeof args?.path === 'string' && args.path ? path.resolve(ctx.root, args.path) : ctx.root;
      const rel = path.relative(ctx.root, dir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return {ok: false, text: 'path must be inside the project'};
      const m = await repoMap(dir, Math.min(20_000, Math.max(500, Number(args?.budget_tokens) || 4000)));
      return m.shown ? {ok: true, text: `${m.text}\n\n(${m.shown} of ${m.files} files with declarations)`} : {ok: true, text: 'No source files with declarations here.'};
    },
  };
}
