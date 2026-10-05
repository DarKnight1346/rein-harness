import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';

/**
 * Models often run `cat`, `grep` or `sed -n` through the shell when a built-in tool does the same
 * job. Rein runs those through the tool instead: same answer, line-numbered like any read, no
 * shell approval, and the file counts as read (so an edit that follows doesn't fail "read it
 * first"). Only exact, simple forms are translated: anything with pipes, redirects, chaining,
 * substitutions or flags not listed here runs in the shell as written.
 */
export type Steered = {tool: 'read' | 'list' | 'search'; args: Record<string, unknown>};

/** Split a command into words, honoring quotes. Undefined if it has anything a plain word list can't express. */
export function words(command: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let has = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && (ch === '$' || ch === '`' || ch === '\\')) return undefined; // expansions inside "…"
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else if ('|&;<>()$`\\*?[]{}~!#'.includes(ch)) return undefined; // pipes, chaining, redirects, globs, substitutions
    else cur += ch;
  }
  if (quote) return undefined;
  if (cur || has) out.push(cur);
  return out;
}

/** A file's text (read once: nothing can change between a check and the read); big files: undefined. */
const textOf = (file: string, root: string): string | undefined => {
  try {
    const data = readFileSync(path.resolve(root, file));
    return data.length > 8 * 1024 * 1024 ? undefined : data.toString('utf8'); // big files: leave them to the shell
  } catch {
    return undefined;
  }
};
const isDir = (p: string, root: string) => {
  try {
    return statSync(path.resolve(root, p)).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string, root: string) => {
  try {
    return statSync(path.resolve(root, p)).isFile();
  } catch {
    return false;
  }
};
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined);

/** The built-in tool call that does what `command` does, if it's one of the simple forms. */
export function steer(command: string, root: string): Steered | undefined {
  const w = words(command);
  if (!w?.length) return undefined;
  const [cmd, ...rest] = w;
  switch (cmd) {
    case 'cat': {
      if (rest.length !== 1 || rest[0]!.startsWith('-') || !isFile(rest[0]!, root)) return undefined;
      return {tool: 'read', args: {path: rest[0]}};
    }
    case 'head':
    case 'tail': {
      let n = 10;
      let file: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === '-n') {
          const v = count(rest[++i]);
          if (v === undefined) return undefined;
          n = v;
        } else if (/^-n?\d+$/.test(a)) n = Number(a.replace(/^-n?/, ''));
        else if (a.startsWith('-') || file) return undefined;
        else file = a;
      }
      if (!file || !isFile(file, root) || n < 1) return undefined;
      if (cmd === 'head') return {tool: 'read', args: {path: file, limit: Math.min(n, 2000)}};
      const text = textOf(file, root);
      if (text === undefined || n > 2000) return undefined;
      // A trailing newline leaves an empty last "line": tail counts real lines.
      const total = text.split('\n').length;
      const real = text.endsWith('\n') ? total - 1 : total;
      return {tool: 'read', args: {path: file, offset: Math.max(1, real - n + 1), limit: n}};
    }
    case 'sed': {
      // sed -n 'A,Bp' FILE / sed -n 'Ap' FILE
      if (rest.length !== 3 || rest[0] !== '-n' || !isFile(rest[2]!, root)) return undefined;
      const m = /^(\d+)(?:,(\d+))?p$/.exec(rest[1]!);
      if (!m) return undefined;
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      if (a < 1 || b < a || b - a >= 2000) return undefined;
      return {tool: 'read', args: {path: rest[2], offset: a, limit: b - a + 1}};
    }
    case 'ls': {
      let all = false;
      let dir: string | undefined;
      for (const a of rest) {
        if (/^-[la1AF]+$/.test(a)) all ||= /[aA]/.test(a);
        else if (a.startsWith('-') || dir) return undefined;
        else dir = a;
      }
      if (dir && !isDir(dir, root)) return undefined;
      return {tool: 'list', args: {...(dir ? {path: dir} : {}), ...(all ? {all: true} : {})}};
    }
    case 'grep':
    case 'rg': {
      let insensitive = false;
      let filesOnly = false;
      let fixed = false;
      let recursive = cmd === 'rg';
      const plain: string[] = [];
      for (const a of rest) {
        if (/^-[a-zA-Z]+$/.test(a)) {
          for (const f of a.slice(1)) {
            if (f === 'i') insensitive = true;
            else if (f === 'l') filesOnly = true;
            else if (f === 'F') fixed = true;
            else if (f === 'r' || f === 'R') recursive = true;
            else if (f === 'n' || f === 'E' || f === 'H' || (cmd === 'rg' && f === 'S')) {
              /* line numbers are always shown; -E is the search tool's syntax anyway */
            } else return undefined;
          }
        } else if (a.startsWith('-')) return undefined;
        else plain.push(a);
      }
      if (filesOnly) return undefined; // the search tool's files_only matches paths, not "files containing"
      if (plain.length < 1 || plain.length > 2) return undefined;
      const [pattern, where] = plain as [string, string | undefined];
      if (where && !(isDir(where, root) ? recursive : isFile(where, root))) return undefined;
      if (!where && !recursive) return undefined; // grep with no file reads stdin
      return {tool: 'search', args: {pattern: fixed ? escapeRegex(pattern) : pattern, ...(where && where !== '.' ? {path: where} : {}), ...(insensitive ? {case_insensitive: true} : {})}};
    }
    case 'find': {
      // find DIR -name PATTERN [-type f]  (PATTERN quoted, so the shell never globbed it)
      const [dir, ...more] = rest;
      if (!dir || dir.startsWith('-') || !isDir(dir, root)) return undefined;
      let name: string | undefined;
      for (let i = 0; i < more.length; i++) {
        const a = more[i]!;
        if (a === '-name' && more[i + 1] !== undefined) name = more[++i];
        else if (a === '-type' && more[i + 1] === 'f') i++;
        else return undefined;
      }
      if (!name) return undefined;
      return {tool: 'search', args: {pattern: '.', files_only: true, glob: name.includes('/') ? name : `**/${name}`, ...(dir !== '.' ? {path: dir} : {})}};
    }
  }
  return undefined;
}
