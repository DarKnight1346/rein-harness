import {spawn} from 'node:child_process';
import {chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {reinHome} from '../store/paths.js';
import {isWindows} from '../util/platform.js';

/**
 * The language servers Rein can run itself, so the agent gets real diagnostics without an editor.
 * Each is found in Rein's own install folder (`<data>/lsp/<id>`), then on the PATH; if it's
 * missing, `lsp_install` installs it there (always asking the user first): with npm, from the
 * project's GitHub release binaries, or with the language's own tool (go, gem, dotnet, a Python
 * venv). Servers Rein can't install say how to get them. Rein never changes the PATH: servers are
 * started by absolute path.
 */
export type Install =
  /** npm packages into lsp/<id>/node_modules (the bin is in node_modules/.bin). */
  | {kind: 'npm'; packages: string[]}
  /** A prebuilt binary from the project's latest GitHub release. `asset` = the file for this platform (undefined = none); `bin` = the executable inside it. */
  | {kind: 'github'; repo: string; asset(p: Platform, version: string): string | undefined; bin(version: string): string}
  /** `go install <module>@latest` with GOBIN=lsp/<id>/bin (needs Go: Go projects have it). */
  | {kind: 'go'; module: string}
  /** `gem install` into lsp/<id> (needs Ruby). */
  | {kind: 'gem'; gem: string}
  /** `dotnet tool install --tool-path lsp/<id>` (needs the .NET SDK). */
  | {kind: 'dotnet'; tool: string}
  /** A Python venv in lsp/<id> with these packages (needs python3). */
  | {kind: 'pip'; packages: string[]}
  /** Rein can't install it: it comes with a toolchain, or needs one to build. `hint` says how. */
  | {kind: 'manual'; hint: string};

export type ServerSpec = {
  id: string;
  name: string;
  /** File extensions (or exact file names, like Dockerfile) it handles, with the LSP languageId for each. */
  languages: Record<string, string>;
  /** Executable name (on the PATH, or in Rein's install folder). */
  bin: string;
  /** Other executables that work the same way if they're on the PATH. */
  alternatives?: string[];
  args: string[];
  install: Install;
  /** Install folder name when servers share one install (HTML, CSS and JSON: one npm package). */
  dir?: string;
  /** LSP initializationOptions for a project root. */
  initOptions?: (root: string) => Record<string, unknown> | undefined;
  /** Choose how to start the server for a project (before the default lookup; undefined = carry on). */
  launch?: (root: string) => Launch | undefined;
};

export type Launch = {command: string; args: string[]; initOptions?: Record<string, unknown>; env?: Record<string, string>; where: 'config' | 'rein' | 'path' | 'project'};
export type Platform = {os: 'mac' | 'linux' | 'windows'; arch: 'x64' | 'arm64'};

export const platform = (): Platform => ({os: process.platform === 'darwin' ? 'mac' : isWindows ? 'windows' : 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64'});
const exe = (name: string) => name + (isWindows ? '.exe' : '');
/** Rust-style target triples, used by several release pages. */
const triple = (p: Platform) => `${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${p.os === 'mac' ? 'apple-darwin' : p.os === 'windows' ? 'pc-windows-msvc' : 'unknown-linux-gnu'}`;

const tsVersion = (dir: string): number | undefined => {
  try {
    return Number((JSON.parse(readFileSync(path.join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')) as {version: string}).version.split('.')[0]);
  } catch {
    return undefined;
  }
};
const nodeBin = (dir: string, name: string) => path.join(dir, 'node_modules', '.bin', name + (isWindows ? '.cmd' : ''));

/**
 * TypeScript 7 (the native compiler) has a language server built in (`tsc --lsp -stdio`); 5 and 6
 * go through typescript-language-server and their own tsserver. Prefer the project's TypeScript,
 * so diagnostics match the compiler it builds with, else the one Rein installed.
 */
function launchTypeScript(root: string): Launch | undefined {
  const own = lspDir('typescript');
  const project = tsVersion(root);
  if (project !== undefined && project >= 7 && existsSync(nodeBin(root, 'tsc'))) return {command: nodeBin(root, 'tsc'), args: ['--lsp', '-stdio'], where: 'project'};
  const tls = existsSync(nodeBin(own, 'typescript-language-server')) ? nodeBin(own, 'typescript-language-server') : onPath('typescript-language-server');
  if (project !== undefined && project < 7 && tls) return {command: tls, args: ['--stdio'], initOptions: {tsserver: {path: path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js')}}, where: 'project'};
  if ((tsVersion(own) ?? 0) >= 7 && existsSync(nodeBin(own, 'tsc'))) return {command: nodeBin(own, 'tsc'), args: ['--lsp', '-stdio'], where: 'rein'};
  if (tls) return {command: tls, args: ['--stdio'], where: 'path'}; // its own TypeScript, wherever that is
  return undefined;
}

const ext = (ids: Record<string, string[]>): Record<string, string> => Object.fromEntries(Object.entries(ids).flatMap(([id, exts]) => exts.map((e) => [e, id])));
const manual = (hint: string): Install => ({kind: 'manual', hint});

export const SERVERS: ServerSpec[] = [
  {
    id: 'typescript',
    name: 'TypeScript / JavaScript',
    languages: ext({typescript: ['.ts', '.mts', '.cts'], typescriptreact: ['.tsx'], javascript: ['.js', '.mjs', '.cjs'], javascriptreact: ['.jsx']}),
    bin: 'typescript-language-server',
    args: ['--stdio'],
    // TypeScript 7 (native, with its own language server) and typescript-language-server for
    // projects on TypeScript 5/6.
    install: {kind: 'npm', packages: ['typescript', 'typescript-language-server']},
    launch: launchTypeScript,
  },
  {id: 'python', name: 'Python (pyright)', languages: ext({python: ['.py', '.pyi']}), bin: 'pyright-langserver', alternatives: ['basedpyright-langserver'], args: ['--stdio'], install: {kind: 'npm', packages: ['pyright']}},
  {
    id: 'cpp',
    name: 'C / C++ / Objective-C / CUDA (clangd)',
    languages: ext({c: ['.c', '.h'], cpp: ['.cc', '.cpp', '.cxx', '.c++', '.hh', '.hpp', '.hxx', '.h++', '.ipp', '.tpp', '.inl'], 'objective-c': ['.m'], 'objective-cpp': ['.mm'], 'cuda-cpp': ['.cu', '.cuh']}),
    bin: 'clangd',
    args: ['--background-index', '--log=error'],
    install: {kind: 'github', repo: 'clangd/clangd', asset: (p, v) => `clangd-${p.os}-${v}.zip`, bin: (v) => `clangd_${v}/bin/${exe('clangd')}`},
  },
  {
    id: 'asm',
    name: 'Assembly: x86/x86-64, ARM, RISC-V, … (asm-lsp)',
    languages: ext({asm: ['.s', '.S', '.asm', '.nasm', '.inc']}),
    bin: 'asm-lsp',
    args: [],
    install: {kind: 'github', repo: 'bergercookie/asm-lsp', asset: (p) => (p.os === 'windows' || (p.os === 'linux' && p.arch === 'arm64') ? undefined : `asm-lsp-${triple(p)}.tar.gz`), bin: () => 'asm-lsp'},
  },
  {
    id: 'rust',
    name: 'Rust (rust-analyzer)',
    languages: ext({rust: ['.rs']}),
    bin: 'rust-analyzer',
    args: [],
    install: {kind: 'github', repo: 'rust-lang/rust-analyzer', asset: (p) => `rust-analyzer-${triple(p)}.${p.os === 'windows' ? 'zip' : 'gz'}`, bin: () => exe('rust-analyzer')},
  },
  {id: 'go', name: 'Go (gopls)', languages: ext({go: ['.go']}), bin: 'gopls', args: [], install: {kind: 'go', module: 'golang.org/x/tools/gopls'}},
  {id: 'java', name: 'Java (jdtls)', languages: ext({java: ['.java']}), bin: 'jdtls', args: [], install: manual('Install Eclipse JDT Language Server and put jdtls on the PATH (macOS: brew install jdtls).')},
  {id: 'kotlin', name: 'Kotlin', languages: ext({kotlin: ['.kt', '.kts']}), bin: 'kotlin-lsp', alternatives: ['kotlin-language-server'], args: ['--stdio'], install: manual('Install the Kotlin language server and put kotlin-lsp (or kotlin-language-server) on the PATH (macOS: brew install JetBrains/utils/kotlin-lsp).')},
  {id: 'scala', name: 'Scala (Metals)', languages: ext({scala: ['.scala', '.sc', '.sbt']}), bin: 'metals', args: [], install: manual('Install Metals with Coursier: cs install metals.')},
  {id: 'csharp', name: 'C# (csharp-ls)', languages: ext({csharp: ['.cs']}), bin: 'csharp-ls', args: [], install: {kind: 'dotnet', tool: 'csharp-ls'}},
  {id: 'fsharp', name: 'F# (fsautocomplete)', languages: ext({fsharp: ['.fs', '.fsi', '.fsx']}), bin: 'fsautocomplete', args: [], install: {kind: 'dotnet', tool: 'fsautocomplete'}},
  {
    id: 'swift',
    name: 'Swift (sourcekit-lsp)',
    languages: ext({swift: ['.swift']}),
    bin: 'sourcekit-lsp',
    args: [],
    install: manual('sourcekit-lsp comes with Xcode and the Swift toolchain (xcode-select --install, or swift.org).'),
    // macOS: through xcrun when only the Command Line Tools / Xcode have it.
    launch: () => (process.platform === 'darwin' && !onPath('sourcekit-lsp') && existsSync('/usr/bin/xcrun') && (existsSync('/Library/Developer/CommandLineTools/usr/bin/sourcekit-lsp') || existsSync('/Applications/Xcode.app')) ? {command: '/usr/bin/xcrun', args: ['sourcekit-lsp'], where: 'path'} : undefined),
  },
  {
    id: 'zig',
    name: 'Zig (zls)',
    languages: ext({zig: ['.zig', '.zon']}),
    bin: 'zls',
    args: [],
    install: {kind: 'github', repo: 'zigtools/zls', asset: (p) => `zls-${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${p.os === 'mac' ? 'macos' : p.os}.${p.os === 'windows' ? 'zip' : 'tar.xz'}`, bin: () => exe('zls')},
  },
  {
    id: 'lua',
    name: 'Lua (lua-language-server)',
    languages: ext({lua: ['.lua']}),
    bin: 'lua-language-server',
    args: [],
    install: {
      kind: 'github',
      repo: 'LuaLS/lua-language-server',
      asset: (p, v) => (p.os === 'windows' ? (p.arch === 'x64' ? `lua-language-server-${v}-win32-x64.zip` : undefined) : `lua-language-server-${v}-${p.os === 'mac' ? 'darwin' : 'linux'}-${p.arch}.tar.gz`),
      bin: () => `bin/${exe('lua-language-server')}`,
    },
  },
  {id: 'ruby', name: 'Ruby (ruby-lsp)', languages: ext({ruby: ['.rb', '.rake', '.gemspec', '.ru']}), bin: 'ruby-lsp', args: [], install: {kind: 'gem', gem: 'ruby-lsp'}},
  {id: 'php', name: 'PHP (intelephense)', languages: ext({php: ['.php', '.phtml']}), bin: 'intelephense', args: ['--stdio'], install: {kind: 'npm', packages: ['intelephense']}},
  {id: 'perl', name: 'Perl (Perl::LanguageServer)', languages: ext({perl: ['.pl', '.pm', '.t']}), bin: 'perl-language-server', alternatives: ['perlnavigator'], args: ['--stdio'], install: manual('Install PerlNavigator (perlnavigator on the PATH), or Perl::LanguageServer with cpanm.')},
  {id: 'r', name: 'R (languageserver)', languages: ext({r: ['.r', '.R', '.rmd', '.Rmd']}), bin: 'R', args: ['--slave', '-e', 'languageserver::run()'], install: manual('In R: install.packages("languageserver").')},
  {id: 'julia', name: 'Julia (LanguageServer.jl)', languages: ext({julia: ['.jl']}), bin: 'julia', args: ['--startup-file=no', '--history-file=no', '-e', 'using LanguageServer; runserver()'], install: manual('In Julia: using Pkg; Pkg.add("LanguageServer").')},
  {id: 'haskell', name: 'Haskell (HLS)', languages: ext({haskell: ['.hs', '.lhs']}), bin: 'haskell-language-server-wrapper', args: ['--lsp'], install: manual('Install haskell-language-server with ghcup (ghcup install hls).')},
  {id: 'ocaml', name: 'OCaml (ocamllsp)', languages: ext({ocaml: ['.ml', '.mli']}), bin: 'ocamllsp', args: [], install: manual('opam install ocaml-lsp-server')},
  {id: 'elixir', name: 'Elixir', languages: ext({elixir: ['.ex', '.exs', '.heex']}), bin: 'elixir-ls', alternatives: ['expert', 'lexical'], args: [], install: manual('Install ElixirLS (macOS: brew install elixir-ls) and put elixir-ls on the PATH.')},
  {id: 'erlang', name: 'Erlang (erlang_ls)', languages: ext({erlang: ['.erl', '.hrl']}), bin: 'erlang_ls', alternatives: ['elp'], args: [], install: manual('Install erlang_ls (macOS: brew install erlang_ls) or ELP.')},
  {id: 'gleam', name: 'Gleam', languages: ext({gleam: ['.gleam']}), bin: 'gleam', args: ['lsp'], install: manual('The Gleam compiler includes it (gleam lsp): install Gleam.')},
  {
    id: 'clojure',
    name: 'Clojure (clojure-lsp)',
    languages: ext({clojure: ['.clj', '.cljs', '.cljc', '.edn']}),
    bin: 'clojure-lsp',
    args: [],
    install: {kind: 'github', repo: 'clojure-lsp/clojure-lsp', asset: (p) => (p.os === 'windows' && p.arch === 'arm64' ? undefined : `clojure-lsp-native-${p.os === 'mac' ? 'macos' : p.os}-${p.arch === 'arm64' ? 'aarch64' : 'amd64'}.zip`), bin: () => exe('clojure-lsp')},
  },
  {id: 'dart', name: 'Dart / Flutter', languages: ext({dart: ['.dart']}), bin: 'dart', args: ['language-server', '--protocol=lsp'], install: manual('The Dart SDK includes it (dart language-server): install Dart or Flutter.')},
  {id: 'elm', name: 'Elm', languages: ext({elm: ['.elm']}), bin: 'elm-language-server', args: ['--stdio'], install: {kind: 'npm', packages: ['@elm-tooling/elm-language-server']}},
  {id: 'nim', name: 'Nim (nimlangserver)', languages: ext({nim: ['.nim', '.nims', '.nimble']}), bin: 'nimlangserver', args: [], install: manual('nimble install nimlangserver')},
  {id: 'fortran', name: 'Fortran (fortls)', languages: ext({fortran: ['.f', '.for', '.f90', '.f95', '.f03', '.f08', '.F', '.F90']}), bin: 'fortls', args: [], install: {kind: 'pip', packages: ['fortls']}},
  {id: 'svelte', name: 'Svelte', languages: ext({svelte: ['.svelte']}), bin: 'svelteserver', args: ['--stdio'], install: {kind: 'npm', packages: ['svelte-language-server']}},
  {id: 'vue', name: 'Vue', languages: ext({vue: ['.vue']}), bin: 'vue-language-server', args: ['--stdio'], install: {kind: 'npm', packages: ['@vue/language-server', 'typescript']}, initOptions: () => ({typescript: {tsdk: path.join(lspDir('vue'), 'node_modules', 'typescript', 'lib')}})},
  {id: 'bash', name: 'Bash / shell scripts', languages: ext({shellscript: ['.sh', '.bash', '.zsh', '.ksh']}), bin: 'bash-language-server', args: ['start'], install: {kind: 'npm', packages: ['bash-language-server']}},
  {id: 'powershell', name: 'PowerShell', languages: ext({powershell: ['.ps1', '.psm1', '.psd1']}), bin: 'pwsh', args: [], install: manual('Install PowerShell Editor Services and start it with -Stdio (see github.com/PowerShell/PowerShellEditorServices); then set lspServers.powershell in config.json.')},
  {id: 'html', dir: 'vscode-langservers', name: 'HTML', languages: ext({html: ['.html', '.htm']}), bin: 'vscode-html-language-server', args: ['--stdio'], install: {kind: 'npm', packages: ['vscode-langservers-extracted']}},
  {id: 'css', dir: 'vscode-langservers', name: 'CSS / SCSS / Less', languages: ext({css: ['.css'], scss: ['.scss'], less: ['.less']}), bin: 'vscode-css-language-server', args: ['--stdio'], install: {kind: 'npm', packages: ['vscode-langservers-extracted']}},
  {id: 'json', dir: 'vscode-langservers', name: 'JSON', languages: ext({json: ['.json'], jsonc: ['.jsonc']}), bin: 'vscode-json-language-server', args: ['--stdio'], install: {kind: 'npm', packages: ['vscode-langservers-extracted']}},
  {id: 'yaml', name: 'YAML', languages: ext({yaml: ['.yaml', '.yml']}), bin: 'yaml-language-server', args: ['--stdio'], install: {kind: 'npm', packages: ['yaml-language-server']}},
  {
    id: 'toml',
    name: 'TOML (taplo)',
    languages: ext({toml: ['.toml']}),
    bin: 'taplo',
    args: ['lsp', 'stdio'],
    install: {
      kind: 'github',
      repo: 'tamasfe/taplo',
      asset: (p) => (p.os === 'windows' ? `taplo-windows-${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}.zip` : `taplo-${p.os === 'mac' ? 'darwin' : 'linux'}-${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}.gz`),
      bin: () => exe('taplo'),
    },
  },
  {
    id: 'markdown',
    name: 'Markdown (marksman)',
    languages: ext({markdown: ['.md', '.markdown']}),
    bin: 'marksman',
    args: ['server'],
    install: {kind: 'github', repo: 'artempyanykh/marksman', asset: (p) => (p.os === 'mac' ? 'marksman-macos' : p.os === 'windows' ? (p.arch === 'x64' ? 'marksman.exe' : undefined) : `marksman-linux-${p.arch}`), bin: () => exe('marksman')},
  },
  // sqls: completion and hover; its diagnostics need a database connection (.sqls config).
  {id: 'sql', name: 'SQL (sqls)', languages: ext({sql: ['.sql']}), bin: 'sqls', args: [], install: {kind: 'go', module: 'github.com/sqls-server/sqls'}},
  {id: 'dockerfile', name: 'Dockerfile', languages: {Dockerfile: 'dockerfile', Containerfile: 'dockerfile', '.dockerfile': 'dockerfile'}, bin: 'docker-langserver', args: ['--stdio'], install: {kind: 'npm', packages: ['dockerfile-language-server-nodejs']}},
  {
    id: 'cmake',
    name: 'CMake (neocmakelsp)',
    languages: {'CMakeLists.txt': 'cmake', '.cmake': 'cmake'},
    bin: 'neocmakelsp',
    alternatives: ['cmake-language-server'],
    args: ['stdio'],
    install: {
      kind: 'github',
      repo: 'neocmakelsp/neocmakelsp',
      asset: (p) => (p.os === 'mac' ? 'neocmakelsp-universal-apple-darwin.tar.gz' : p.os === 'windows' ? `neocmakelsp-${triple(p)}.zip` : `neocmakelsp-${triple(p)}.tar.gz`),
      bin: () => exe('neocmakelsp'),
    },
  },
  {id: 'terraform', name: 'Terraform (terraform-ls)', languages: ext({terraform: ['.tf', '.tfvars']}), bin: 'terraform-ls', args: ['serve'], install: manual('Install terraform-ls from HashiCorp (macOS: brew install hashicorp/tap/terraform-ls).')},
  {id: 'nix', name: 'Nix (nil)', languages: ext({nix: ['.nix']}), bin: 'nil', alternatives: ['nixd'], args: [], install: manual('Install nil or nixd (nix profile install nixpkgs#nil).')},
];

/** The server for a file: by exact name (Dockerfile, CMakeLists.txt), then extension (case-sensitive first: `.S`, `.R`). */
export const serverFor = (file: string): ServerSpec | undefined => {
  const base = path.basename(file);
  const extension = path.extname(file);
  return SERVERS.find((s) => base in s.languages) ?? SERVERS.find((s) => extension in s.languages) ?? SERVERS.find((s) => extension.toLowerCase() in s.languages);
};
export const languageIdFor = (spec: ServerSpec, file: string): string => spec.languages[path.basename(file)] ?? spec.languages[path.extname(file)] ?? spec.languages[path.extname(file).toLowerCase()] ?? 'plaintext';
export const serverById = (id: string): ServerSpec | undefined => SERVERS.find((s) => s.id === id);
export const lspDir = (id: string) => path.join(reinHome(), 'lsp', id);
const dirOf = (spec: ServerSpec) => lspDir(spec.dir ?? spec.id);
/** File patterns for a server's languages (for `git grep`). */
export const filePatterns = (spec: ServerSpec): string[] => Object.keys(spec.languages).map((k) => (k.startsWith('.') ? `*${k}` : k));

function onPath(bin: string): string | undefined {
  const exts = isWindows ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = path.join(dir, bin + e);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

type Installed = {id: string; version: string; at: string; bin?: string};
function installedInfo(spec: ServerSpec): Installed | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dirOf(spec), 'installed.json'), 'utf8')) as Installed;
  } catch {
    return undefined;
  }
}

/** Where Rein's own install of a server keeps its executable (undefined = none). */
function ownInstall(spec: ServerSpec): {command: string; env?: Record<string, string>} | undefined {
  const dir = dirOf(spec);
  const i = spec.install;
  const first = (...ps: string[]) => ps.find((p) => existsSync(p));
  if (i.kind === 'npm') {
    const p = nodeBin(dir, spec.bin);
    return existsSync(p) ? {command: p} : undefined;
  }
  if (i.kind === 'github') {
    const bin = installedInfo(spec)?.bin;
    return bin && existsSync(path.join(dir, bin)) ? {command: path.join(dir, bin)} : undefined;
  }
  if (i.kind === 'go') {
    const p = first(path.join(dir, 'bin', exe(spec.bin)));
    return p ? {command: p} : undefined;
  }
  if (i.kind === 'gem') {
    const p = first(path.join(dir, 'bin', spec.bin), path.join(dir, 'bin', `${spec.bin}.bat`));
    return p ? {command: p, env: {GEM_HOME: dir, GEM_PATH: [dir, process.env.GEM_PATH].filter(Boolean).join(path.delimiter)}} : undefined;
  }
  if (i.kind === 'pip') {
    const p = first(path.join(dir, 'bin', spec.bin), path.join(dir, 'Scripts', exe(spec.bin)));
    return p ? {command: p} : undefined;
  }
  if (i.kind === 'dotnet') {
    const p = first(path.join(dir, exe(spec.bin)));
    return p ? {command: p} : undefined;
  }
  return undefined;
}

/** How to start a server for a project: configured, then the spec's own choice, Rein's install, the PATH. */
export function resolveServer(spec: ServerSpec, overrides: Record<string, {command: string; args?: string[]}> = {}, root = process.cwd()): Launch | undefined {
  const o = overrides[spec.id];
  if (o?.command) return {command: o.command, args: o.args ?? spec.args, where: 'config'};
  if (spec.launch) {
    const l = spec.launch(root);
    if (l || spec.id === 'typescript') return l; // TypeScript's choice is final; others carry on
  }
  const own = ownInstall(spec);
  if (own) return {command: own.command, args: spec.args, env: own.env, where: 'rein'};
  for (const bin of [spec.bin, ...(spec.alternatives ?? [])]) {
    const found = onPath(bin);
    if (found) return {command: found, args: spec.args, where: 'path'};
  }
  return undefined;
}

/** The version Rein installed, if it installed this server. */
export function installedVersion(spec: ServerSpec): string | undefined {
  return installedInfo(spec)?.version;
}

const TOOL: Record<string, string> = {npm: 'npm', go: 'go', gem: 'gem', dotnet: 'dotnet', pip: 'python3'};

/** Can Rein install this server on this machine? The reason when it can't. */
export function installable(spec: ServerSpec): {ok: true} | {ok: false; why: string} {
  const i = spec.install;
  if (i.kind === 'manual') return {ok: false, why: i.hint};
  if (i.kind === 'github' && !i.asset(platform(), '0')) return {ok: false, why: `there's no prebuilt ${spec.name} for ${process.platform}/${process.arch}; install it yourself and put ${spec.bin} on the PATH.`};
  const tool = TOOL[i.kind];
  if (tool && !onPath(tool) && !(tool === 'python3' && onPath('python'))) return {ok: false, why: `installing it needs ${tool}, which isn't on the PATH.`};
  return {ok: true};
}

function runTool(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ok: boolean; out: string}> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command, args, {cwd, env, shell: isWindows, windowsHide: true});
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ok: false, out: err.message}));
    child.on('close', (code) => resolve({ok: code === 0, out: out.trim().slice(-1500)}));
  });
}

/** Unpack a downloaded release file into `dir`: archives with tar (zip too, except GNU tar), .gz with zlib, else as is. */
export async function unpack(file: string, asset: string, dir: string, bin: string): Promise<void> {
  if (/\.(tar\.gz|tgz|tar\.xz)$/.test(asset) || (asset.endsWith('.zip') && process.platform !== 'linux')) {
    const r = await runTool('tar', ['-xf', file, '-C', dir], dir);
    if (!r.ok) throw new Error(`couldn't unpack ${asset}: ${r.out}`);
  } else if (asset.endsWith('.zip')) {
    // GNU tar can't read zip: unzip, else Python's zipfile.
    const r = (await runTool('unzip', ['-q', '-o', file, '-d', dir], dir)).ok || (await runTool('python3', ['-m', 'zipfile', '-e', file, dir], dir)).ok;
    if (!r) throw new Error(`couldn't unpack ${asset}: install unzip`);
  } else if (asset.endsWith('.gz')) {
    await pipeline(createReadStream(file), createGunzip(), createWriteStream(path.join(dir, bin)));
  } else copyFileSync(file, path.join(dir, bin));
  const target = path.join(dir, bin);
  if (!existsSync(target)) throw new Error(`${bin} wasn't in ${asset} (found: ${readdirSync(dir).join(', ')})`);
  if (!isWindows) chmodSync(target, 0o755);
}

async function installGithub(spec: ServerSpec, i: Extract<Install, {kind: 'github'}>, dir: string): Promise<{version: string; bin: string}> {
  const rel = await fetch(`https://api.github.com/repos/${i.repo}/releases/latest`, {headers: {accept: 'application/vnd.github+json', 'user-agent': 'rein-harness'}});
  if (!rel.ok) throw new Error(`couldn't read ${i.repo}'s latest release (HTTP ${rel.status})`);
  const {tag_name: tag} = (await rel.json()) as {tag_name: string};
  const version = tag.replace(/^v/, '');
  const asset = i.asset(platform(), version);
  if (!asset) throw new Error(`there's no prebuilt ${spec.name} for ${process.platform}/${process.arch}`);
  const res = await fetch(`https://github.com/${i.repo}/releases/download/${tag}/${asset}`);
  if (!res.ok || !res.body) throw new Error(`download of ${asset} failed (HTTP ${res.status})`);
  // Unpack into a fresh folder, then swap: a failed update keeps the old server.
  const fresh = `${dir}.new`;
  rmSync(fresh, {recursive: true, force: true});
  mkdirSync(fresh, {recursive: true});
  const file = path.join(os.tmpdir(), `rein-lsp-${process.pid}-${asset}`);
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
    const bin = i.bin(version);
    await unpack(file, asset, fresh, bin);
    rmSync(dir, {recursive: true, force: true});
    renameSync(fresh, dir);
    return {version, bin};
  } finally {
    rmSync(file, {force: true});
    rmSync(fresh, {recursive: true, force: true});
  }
}

/**
 * Install a server into Rein's folder (the latest version). Returns what happened. The agent's
 * `lsp_install` tool is the only caller, and it always asks the user first.
 */
export async function installServer(spec: ServerSpec): Promise<{ok: boolean; text: string}> {
  const can = installable(spec);
  if (!can.ok) return {ok: false, text: `Rein can't install ${spec.name} itself: ${can.why}`};
  const dir = dirOf(spec);
  const i = spec.install;
  try {
    let version = 'latest';
    let bin: string | undefined;
    if (i.kind === 'github') ({version, bin} = await installGithub(spec, i, dir));
    else {
      mkdirSync(dir, {recursive: true});
      let r: {ok: boolean; out: string} = {ok: false, out: ''};
      if (i.kind === 'npm') {
        if (!existsSync(path.join(dir, 'package.json'))) writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: `rein-lsp-${spec.id}`, private: true}));
        r = await runTool(isWindows ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...i.packages], dir);
        try {
          version = (JSON.parse(readFileSync(path.join(dir, 'node_modules', i.packages[0]!, 'package.json'), 'utf8')) as {version: string}).version;
        } catch {}
      } else if (i.kind === 'go') r = await runTool('go', ['install', `${i.module}@latest`], dir, {...process.env, GOBIN: path.join(dir, 'bin')});
      else if (i.kind === 'gem') r = await runTool('gem', ['install', i.gem, '--install-dir', dir, '--bindir', path.join(dir, 'bin'), '--no-document'], dir);
      else if (i.kind === 'dotnet') r = await runTool('dotnet', ['tool', 'install', i.tool, '--tool-path', dir], dir);
      else if (i.kind === 'pip') {
        const py = onPath('python3') ? 'python3' : 'python';
        r = await runTool(py, ['-m', 'venv', dir], dir);
        const pip = isWindows ? path.join(dir, 'Scripts', 'pip.exe') : path.join(dir, 'bin', 'pip');
        if (r.ok) r = await runTool(pip, ['install', '--disable-pip-version-check', '-q', ...i.packages], dir);
      }
      if (!r.ok) return {ok: false, text: `Installing ${spec.name} failed:\n${r.out}`};
    }
    writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({id: spec.id, version, bin, at: new Date().toISOString()} satisfies Installed));
    if (!ownInstall(spec)) return {ok: false, text: `Installed, but ${spec.bin} isn't where Rein expected it in ${dir}.`};
    return {ok: true, text: `Installed ${spec.name} ${version} into ${dir}.`};
  } catch (err) {
    return {ok: false, text: `Installing ${spec.name} failed: ${(err as Error).message}`};
  }
}
