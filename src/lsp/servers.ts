import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {reinHome} from '../store/paths.js';
import {isWindows} from '../util/platform.js';

/**
 * The language servers Rein can run itself, so the agent gets real diagnostics without an editor.
 * Each is found in Rein's own install folder (`<data>/lsp/<id>`), then on the PATH; if it's
 * missing, `lsp_install` installs it there with npm (always asking the user first). Rein never
 * changes the PATH: servers are started by absolute path.
 */
export type ServerSpec = {
  id: string;
  name: string;
  /** File extensions it handles, with the LSP languageId for each. */
  languages: Record<string, string>;
  /** Executable name (in node_modules/.bin when installed by Rein, or on the PATH). */
  bin: string;
  /** Other executables that work the same way if they're on the PATH. */
  alternatives?: string[];
  args: string[];
  /** npm packages to install (the first one is the server, the rest what it needs). */
  npm: string[];
  /** LSP initializationOptions for a project root (e.g. where TypeScript itself is). */
  initOptions?: (root: string) => Record<string, unknown> | undefined;
  /** Choose how to start the server for a project (overrides bin/args when it returns something). */
  launch?: (root: string) => Launch | undefined;
};

export type Launch = {command: string; args: string[]; initOptions?: Record<string, unknown>; where: 'config' | 'rein' | 'path' | 'project'};

const tsVersion = (dir: string): number | undefined => {
  try {
    return Number((JSON.parse(readFileSync(path.join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')) as {version: string}).version.split('.')[0]);
  } catch {
    return undefined;
  }
};
const bin = (dir: string, name: string) => path.join(dir, 'node_modules', '.bin', name + (isWindows ? '.cmd' : ''));

/**
 * TypeScript 7 (the native compiler) has a language server built in (`tsc --lsp -stdio`); 5 and 6
 * go through typescript-language-server and their own tsserver. Prefer the project's TypeScript,
 * so diagnostics match the compiler it builds with, else the one Rein installed.
 */
function launchTypeScript(root: string): Launch | undefined {
  const own = lspDir('typescript');
  const project = tsVersion(root);
  if (project !== undefined && project >= 7 && existsSync(bin(root, 'tsc'))) return {command: bin(root, 'tsc'), args: ['--lsp', '-stdio'], where: 'project'};
  const tls = existsSync(bin(own, 'typescript-language-server')) ? bin(own, 'typescript-language-server') : onPath('typescript-language-server');
  if (project !== undefined && project < 7 && tls) return {command: tls, args: ['--stdio'], initOptions: {tsserver: {path: path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js')}}, where: 'project'};
  if ((tsVersion(own) ?? 0) >= 7 && existsSync(bin(own, 'tsc'))) return {command: bin(own, 'tsc'), args: ['--lsp', '-stdio'], where: 'rein'};
  if (tls) return {command: tls, args: ['--stdio'], where: 'path'}; // its own TypeScript, wherever that is
  return undefined;
}

export const SERVERS: ServerSpec[] = [
  {
    id: 'typescript',
    name: 'TypeScript / JavaScript',
    languages: {'.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript'},
    bin: 'typescript-language-server',
    args: ['--stdio'],
    // TypeScript 7 (native, with its own language server) and typescript-language-server for
    // projects on TypeScript 5/6.
    npm: ['typescript', 'typescript-language-server'],
    launch: launchTypeScript,
  },
  {
    id: 'python',
    name: 'Python (pyright)',
    languages: {'.py': 'python', '.pyi': 'python'},
    bin: 'pyright-langserver',
    alternatives: ['basedpyright-langserver'],
    args: ['--stdio'],
    npm: ['pyright'],
  },
];

export const serverFor = (file: string): ServerSpec | undefined => SERVERS.find((s) => path.extname(file).toLowerCase() in s.languages);
export const serverById = (id: string): ServerSpec | undefined => SERVERS.find((s) => s.id === id);
export const lspDir = (id: string) => path.join(reinHome(), 'lsp', id);

function onPath(bin: string): string | undefined {
  const exts = isWindows ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** How to start a server for a project: configured, then the spec's own choice, Rein's install, the PATH. */
export function resolveServer(spec: ServerSpec, overrides: Record<string, {command: string; args?: string[]}> = {}, root = process.cwd()): Launch | undefined {
  const o = overrides[spec.id];
  if (o?.command) return {command: o.command, args: o.args ?? spec.args, where: 'config'};
  if (spec.launch) return spec.launch(root);
  const own = path.join(lspDir(spec.id), 'node_modules', '.bin', spec.bin + (isWindows ? '.cmd' : ''));
  if (existsSync(own)) return {command: own, args: spec.args, where: 'rein'};
  for (const bin of [spec.bin, ...(spec.alternatives ?? [])]) {
    const found = onPath(bin);
    if (found) return {command: found, args: spec.args, where: 'path'};
  }
  return undefined;
}

/** The version Rein installed, if it installed this server. */
export function installedVersion(spec: ServerSpec): string | undefined {
  try {
    return (JSON.parse(readFileSync(path.join(lspDir(spec.id), 'installed.json'), 'utf8')) as {version?: string}).version;
  } catch {
    return undefined;
  }
}

/**
 * Install a server into Rein's folder with npm (the latest version). Returns what happened. The
 * agent's `lsp_install` tool is the only caller, and it always asks the user first.
 */
export function installServer(spec: ServerSpec): Promise<{ok: boolean; text: string}> {
  const dir = lspDir(spec.id);
  mkdirSync(dir, {recursive: true});
  if (!existsSync(path.join(dir, 'package.json'))) writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: `rein-lsp-${spec.id}`, private: true}));
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(isWindows ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...spec.npm], {cwd: dir, env: process.env, shell: isWindows});
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ok: false, text: `couldn't run npm: ${err.message}`}));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ok: false, text: `npm install failed (exit ${code}):\n${out.trim().slice(-1500)}`});
      let version = '?';
      try {
        version = (JSON.parse(readFileSync(path.join(dir, 'node_modules', spec.npm[0]!, 'package.json'), 'utf8')) as {version: string}).version;
      } catch {}
      writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({id: spec.id, packages: spec.npm, version, at: new Date().toISOString()}));
      resolve({ok: true, text: `Installed ${spec.name} ${version} into ${dir}.`});
    });
  });
}
