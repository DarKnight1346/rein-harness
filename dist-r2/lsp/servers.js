import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { reinHome } from '../store/paths.js';
import { isWindows } from '../util/platform.js';
export const platform = () => ({ os: process.platform === 'darwin' ? 'mac' : isWindows ? 'windows' : 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' });
export const exe = (name) => name + (isWindows ? '.exe' : '');
/** Rust-style target triples, used by several release pages. */
const triple = (p) => `${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${p.os === 'mac' ? 'apple-darwin' : p.os === 'windows' ? 'pc-windows-msvc' : 'unknown-linux-gnu'}`;
const tsVersion = (dir) => {
    try {
        return Number(JSON.parse(readFileSync(path.join(dir, 'node_modules', 'typescript', 'package.json'), 'utf8')).version.split('.')[0]);
    }
    catch {
        return undefined;
    }
};
const nodeBin = (dir, name) => path.join(dir, 'node_modules', '.bin', name + (isWindows ? '.cmd' : ''));
/**
 * TypeScript 7 (the native compiler) has a language server built in (`tsc --lsp -stdio`); 5 and 6
 * go through typescript-language-server and their own tsserver. Prefer the project's TypeScript,
 * so diagnostics match the compiler it builds with, else the one Rein installed.
 */
function launchTypeScript(root) {
    const own = lspDir('typescript');
    const project = tsVersion(root);
    if (project !== undefined && project >= 7 && existsSync(nodeBin(root, 'tsc')))
        return { command: nodeBin(root, 'tsc'), args: ['--lsp', '-stdio'], where: 'project' };
    const tls = existsSync(nodeBin(own, 'typescript-language-server')) ? nodeBin(own, 'typescript-language-server') : onPath('typescript-language-server');
    if (project !== undefined && project < 7 && tls)
        return { command: tls, args: ['--stdio'], initOptions: { tsserver: { path: path.join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js') } }, where: 'project' };
    if ((tsVersion(own) ?? 0) >= 7 && existsSync(nodeBin(own, 'tsc')))
        return { command: nodeBin(own, 'tsc'), args: ['--lsp', '-stdio'], where: 'rein' };
    if (tls)
        return { command: tls, args: ['--stdio'], where: 'path' }; // its own TypeScript, wherever that is
    return undefined;
}
const ext = (ids) => Object.fromEntries(Object.entries(ids).flatMap(([id, exts]) => exts.map((e) => [e, id])));
const manual = (hint) => ({ kind: 'manual', hint });
export const SERVERS = [
    {
        id: 'typescript',
        name: 'TypeScript / JavaScript',
        languages: ext({ typescript: ['.ts', '.mts', '.cts'], typescriptreact: ['.tsx'], javascript: ['.js', '.mjs', '.cjs'], javascriptreact: ['.jsx'] }),
        bin: 'typescript-language-server',
        args: ['--stdio'],
        // TypeScript 7 (native, with its own language server) and typescript-language-server for
        // projects on TypeScript 5/6.
        install: { kind: 'npm', packages: ['typescript', 'typescript-language-server'] },
        launch: launchTypeScript,
    },
    { id: 'python', name: 'Python (pyright)', languages: ext({ python: ['.py', '.pyi'] }), bin: 'pyright-langserver', alternatives: ['basedpyright-langserver'], args: ['--stdio'], install: { kind: 'npm', packages: ['pyright'] } },
    {
        id: 'cpp',
        name: 'C / C++ / Objective-C / CUDA (clangd)',
        languages: ext({ c: ['.c', '.h'], cpp: ['.cc', '.cpp', '.cxx', '.c++', '.hh', '.hpp', '.hxx', '.h++', '.ipp', '.tpp', '.inl'], 'objective-c': ['.m'], 'objective-cpp': ['.mm'], 'cuda-cpp': ['.cu', '.cuh'] }),
        bin: 'clangd',
        args: ['--background-index', '--log=error'],
        install: { kind: 'github', repo: 'clangd/clangd', asset: (p, v) => `clangd-${p.os}-${v}.zip`, bin: (v) => `clangd_${v}/bin/${exe('clangd')}` },
    },
    {
        id: 'asm',
        name: 'Assembly: x86/x86-64, ARM, RISC-V, … (asm-lsp)',
        languages: ext({ asm: ['.s', '.S', '.asm', '.nasm', '.inc'] }),
        bin: 'asm-lsp',
        args: [],
        install: { kind: 'github', repo: 'bergercookie/asm-lsp', asset: (p) => (p.os === 'windows' || (p.os === 'linux' && p.arch === 'arm64') ? undefined : `asm-lsp-${triple(p)}.tar.gz`), bin: () => 'asm-lsp' },
    },
    {
        id: 'rust',
        name: 'Rust (rust-analyzer)',
        languages: ext({ rust: ['.rs'] }),
        bin: 'rust-analyzer',
        args: [],
        install: { kind: 'github', repo: 'rust-lang/rust-analyzer', asset: (p) => `rust-analyzer-${triple(p)}.${p.os === 'windows' ? 'zip' : 'gz'}`, bin: () => exe('rust-analyzer') },
    },
    { id: 'go', name: 'Go (gopls)', languages: ext({ go: ['.go'] }), bin: 'gopls', args: [], install: { kind: 'go', module: 'golang.org/x/tools/gopls' } },
    {
        id: 'java',
        name: 'Java (Eclipse JDT LS)',
        languages: ext({ java: ['.java'] }),
        bin: 'jdtls',
        args: [],
        needs: ['java'],
        install: {
            kind: 'custom',
            run: async (dir, h) => {
                await h.fetchUnpack('https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz', 'jdt-language-server-latest.tar.gz', 'bin/jdtls');
                const launcher = readdirSync(path.join(dir, 'plugins')).find((f) => f.startsWith('org.eclipse.equinox.launcher_') && f.endsWith('.jar'));
                if (!launcher)
                    throw new Error('the jdtls download has no launcher jar');
                return { version: 'latest snapshot', bin: `plugins/${launcher}` };
            },
        },
        // java -jar <launcher> with jdtls's settings; each project gets its own workspace folder.
        launch: (root) => {
            const own = ownBin(serverById('java'));
            const java = javaCmd();
            if (own && java) {
                const p = platform();
                const config = `config_${p.os === 'windows' ? 'win' : p.os}${p.arch === 'arm64' && p.os !== 'windows' ? '_arm' : ''}`;
                const data = path.join(own.dir, 'workspaces', createHash('sha256').update(root).digest('hex').slice(0, 16));
                return {
                    command: java,
                    args: ['-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', own.bin, '-configuration', path.join(own.dir, config), '-data', data],
                    where: 'rein',
                };
            }
            const jdtls = onPath('jdtls');
            return jdtls ? { command: jdtls, args: ['-data', path.join(os.tmpdir(), 'rein-jdtls', createHash('sha256').update(root).digest('hex').slice(0, 16))], where: 'path' } : undefined;
        },
        wrapped: true,
    },
    {
        id: 'kotlin',
        name: 'Kotlin (JetBrains kotlin-lsp)',
        languages: ext({ kotlin: ['.kt', '.kts'] }),
        bin: 'kotlin-lsp',
        alternatives: ['kotlin-language-server'],
        args: ['--stdio'],
        install: {
            kind: 'custom',
            // JetBrains' standalone build (it bundles its own Java runtime): about 360 MB.
            run: async (_dir, h) => {
                const { tag } = await h.release('Kotlin/kotlin-lsp');
                const v = tag.replace(/^.*v/, '');
                const arm = h.platform.arch === 'arm64' ? '-aarch64' : '';
                const asset = `kotlin-server-${v}${arm}${h.platform.os === 'mac' ? '.sit' : h.platform.os === 'windows' ? '.win.zip' : '.tar.gz'}`;
                const bin = await h.fetchUnpack(`https://download.jetbrains.com/language-server/kotlin-server/${v}/${asset}`, asset, isWindows ? 'kotlin-lsp.cmd' : 'kotlin-lsp.sh');
                return { version: v, bin };
            },
        },
    },
    {
        id: 'scala',
        name: 'Scala (Metals)',
        languages: ext({ scala: ['.scala', '.sc', '.sbt'] }),
        bin: 'metals',
        args: [],
        needs: ['java'],
        install: {
            kind: 'custom',
            // Coursier (Scala's installer) fetched from its releases, then `cs install metals`.
            run: async (dir, h) => {
                const p = h.platform;
                const arch = p.arch === 'arm64' ? 'aarch64' : 'x86_64';
                const asset = p.os === 'windows' ? 'cs-x86_64-pc-win32.zip' : `cs-${arch}-${p.os === 'mac' ? 'apple-darwin' : 'pc-linux'}.gz`;
                const { tag } = await h.release('coursier/coursier');
                const cs = await h.fetchUnpack(`https://github.com/coursier/coursier/releases/download/${tag}/${asset}`, asset, exe('cs'));
                const r = await h.run(cs, ['install', 'metals', '--install-dir', path.join(dir, 'bin')], javaEnv());
                if (!r.ok)
                    throw new Error(r.out);
                return { version: 'latest', bin: path.join(dir, 'bin', isWindows ? 'metals.bat' : 'metals') };
            },
        },
    },
    { id: 'csharp', name: 'C# (csharp-ls)', languages: ext({ csharp: ['.cs'] }), bin: 'csharp-ls', args: [], install: { kind: 'dotnet', tool: 'csharp-ls' } },
    { id: 'fsharp', name: 'F# (fsautocomplete)', languages: ext({ fsharp: ['.fs', '.fsi', '.fsx'] }), bin: 'fsautocomplete', args: [], install: { kind: 'dotnet', tool: 'fsautocomplete' } },
    {
        id: 'swift',
        name: 'Swift (sourcekit-lsp)',
        languages: ext({ swift: ['.swift'] }),
        bin: 'sourcekit-lsp',
        args: [],
        install: manual('sourcekit-lsp comes with Xcode and the Swift toolchain (xcode-select --install, or swift.org).'),
        // macOS: through xcrun when only the Command Line Tools / Xcode have it.
        launch: () => (process.platform === 'darwin' && !onPath('sourcekit-lsp') && existsSync('/usr/bin/xcrun') && (existsSync('/Library/Developer/CommandLineTools/usr/bin/sourcekit-lsp') || existsSync('/Applications/Xcode.app')) ? { command: '/usr/bin/xcrun', args: ['sourcekit-lsp'], where: 'path' } : undefined),
    },
    {
        id: 'zig',
        name: 'Zig (zls)',
        languages: ext({ zig: ['.zig', '.zon'] }),
        bin: 'zls',
        args: [],
        install: { kind: 'github', repo: 'zigtools/zls', asset: (p) => `zls-${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${p.os === 'mac' ? 'macos' : p.os}.${p.os === 'windows' ? 'zip' : 'tar.xz'}`, bin: () => exe('zls') },
    },
    {
        id: 'lua',
        name: 'Lua (lua-language-server)',
        languages: ext({ lua: ['.lua'] }),
        bin: 'lua-language-server',
        args: [],
        install: {
            kind: 'github',
            repo: 'LuaLS/lua-language-server',
            asset: (p, v) => (p.os === 'windows' ? (p.arch === 'x64' ? `lua-language-server-${v}-win32-x64.zip` : undefined) : `lua-language-server-${v}-${p.os === 'mac' ? 'darwin' : 'linux'}-${p.arch}.tar.gz`),
            bin: () => `bin/${exe('lua-language-server')}`,
        },
    },
    { id: 'ruby', name: 'Ruby (ruby-lsp)', languages: ext({ ruby: ['.rb', '.rake', '.gemspec', '.ru'] }), bin: 'ruby-lsp', args: [], install: { kind: 'gem', gem: 'ruby-lsp' } },
    { id: 'php', name: 'PHP (intelephense)', languages: ext({ php: ['.php', '.phtml'] }), bin: 'intelephense', args: ['--stdio'], install: { kind: 'npm', packages: ['intelephense'] } },
    {
        id: 'perl',
        name: 'Perl (PerlNavigator)',
        languages: ext({ perl: ['.pl', '.pm', '.t'] }),
        bin: 'perlnavigator',
        alternatives: ['perl-language-server'],
        args: ['--stdio'],
        needs: ['perl'],
        install: {
            kind: 'custom',
            run: async (_dir, h) => {
                const p = h.platform;
                const asset = `perlnavigator-${p.os === 'mac' ? 'macos' : p.os === 'windows' ? 'win' : 'linux'}-x86_64.zip`;
                if (p.os === 'linux' && p.arch === 'arm64')
                    throw new Error('PerlNavigator has no Linux arm64 build');
                const { tag } = await h.release('bscan/PerlNavigator');
                const bin = await h.fetchUnpack(`https://github.com/bscan/PerlNavigator/releases/download/${tag}/${asset}`, asset, exe('perlnavigator'));
                return { version: tag, bin };
            },
        },
    },
    {
        id: 'r',
        name: 'R (languageserver)',
        languages: ext({ r: ['.r', '.R', '.rmd', '.Rmd'] }),
        bin: 'R',
        args: ['--slave', '-e', 'languageserver::run()'],
        needs: ['Rscript'],
        install: {
            kind: 'custom',
            // The languageserver package into Rein's folder (a private R library).
            run: async (dir, h) => {
                const lib = dir.replace(/\\/g, '/');
                const r = await h.run('Rscript', ['-e', `install.packages("languageserver", lib = "${lib}", repos = "https://cloud.r-project.org")`]);
                if (!existsSync(path.join(dir, 'languageserver')))
                    throw new Error(r.out || 'the package did not install');
                return { version: 'latest', bin: path.join(dir, 'languageserver') };
            },
        },
        launch: () => {
            const own = ownBin(serverById('r'));
            const R = onPath('R');
            return own && R ? { command: R, args: ['--slave', '-e', 'languageserver::run()'], env: { R_LIBS: own.dir }, where: 'rein' } : undefined;
        },
    },
    {
        id: 'julia',
        name: 'Julia (LanguageServer.jl)',
        languages: ext({ julia: ['.jl'] }),
        bin: 'julia',
        args: [],
        needs: ['julia'],
        install: {
            kind: 'custom',
            // LanguageServer.jl into its own Julia environment in Rein's folder.
            run: async (dir, h) => {
                const r = await h.run('julia', [`--project=${dir}`, '--startup-file=no', '-e', 'using Pkg; Pkg.add(["LanguageServer", "SymbolServer"]); using LanguageServer']);
                if (!r.ok || !existsSync(path.join(dir, 'Project.toml')))
                    throw new Error(r.out);
                return { version: 'latest', bin: path.join(dir, 'Project.toml') };
            },
        },
        wrapped: true,
        // The project being edited is passed as the environment to analyze.
        launch: (root) => {
            const own = ownBin(serverById('julia'));
            const julia = onPath('julia');
            return own && julia ? { command: julia, args: [`--project=${own.dir}`, '--startup-file=no', '--history-file=no', '-e', 'using LanguageServer; runserver(stdin, stdout, ARGS[1])', root], where: 'rein' } : undefined;
        },
    },
    {
        id: 'haskell',
        name: 'Haskell (HLS)',
        languages: ext({ haskell: ['.hs', '.lhs'] }),
        bin: 'haskell-language-server-wrapper',
        args: ['--lsp'],
        needs: ['ghc', 'ghcup', 'stack'],
        install: {
            kind: 'custom',
            // ghcup (Haskell's installer) into Rein's folder, then `ghcup install hls` there too.
            run: async (dir, h) => {
                const p = h.platform;
                if (p.os === 'windows')
                    throw new Error('on Windows, install HLS with ghcup yourself (ghcup install hls)');
                const name = `${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${p.os === 'mac' ? 'apple-darwin' : 'linux'}-ghcup`;
                const ghcup = onPath('ghcup') ?? (await h.fetchUnpack(`https://downloads.haskell.org/~ghcup/${name}`, name, 'ghcup'));
                const r = await h.run(ghcup, ['install', 'hls', '--set'], { ...process.env, GHCUP_INSTALL_BASE_PREFIX: dir });
                if (!r.ok)
                    throw new Error(r.out);
                return { version: 'recommended', bin: path.join(dir, '.ghcup', 'bin', 'haskell-language-server-wrapper') };
            },
        },
    },
    {
        id: 'ocaml',
        name: 'OCaml (ocamllsp)',
        languages: ext({ ocaml: ['.ml', '.mli'] }),
        bin: 'ocamllsp',
        args: [],
        needs: ['opam'],
        install: {
            kind: 'custom',
            // Into the current opam switch (where the project's OCaml lives), with opam itself.
            run: async (_dir, h) => {
                const r = await h.run('opam', ['install', '-y', 'ocaml-lsp-server']);
                if (!r.ok)
                    throw new Error(r.out);
                const bin = (await h.run('opam', ['var', 'bin'])).out.trim().split('\n').pop();
                return { version: 'latest', bin: path.join(bin, exe('ocamllsp')) };
            },
        },
    },
    {
        id: 'elixir',
        name: 'Elixir (ElixirLS)',
        languages: ext({ elixir: ['.ex', '.exs', '.heex'] }),
        bin: 'elixir-ls',
        alternatives: ['expert', 'lexical'],
        args: [],
        needs: ['elixir'],
        install: {
            kind: 'custom',
            // ElixirLS compiles itself on its first launch (a minute or more): do that now, not on the agent's first edit.
            run: async (_dir, h) => {
                const { tag } = await h.release('elixir-lsp/elixir-ls');
                const asset = `elixir-ls-${tag}.zip`;
                const bin = await h.fetchUnpack(`https://github.com/elixir-lsp/elixir-ls/releases/download/${tag}/${asset}`, asset, isWindows ? 'language_server.bat' : 'language_server.sh');
                await h.run(bin, []); // compiles, sees no input, exits
                return { version: tag.replace(/^v/, ''), bin };
            },
        },
    },
    {
        id: 'erlang',
        name: 'Erlang (ELP)',
        languages: ext({ erlang: ['.erl', '.hrl'] }),
        bin: 'elp',
        alternatives: ['erlang_ls'],
        args: ['server'],
        needs: ['erl'],
        install: {
            kind: 'custom',
            // ELP ships one build per Erlang/OTP release: the one for the installed OTP (or the closest older one).
            run: async (_dir, h) => {
                const otp = Number((await h.run('erl', ['-noshell', '-eval', 'io:put_chars(erlang:system_info(otp_release)), halt().'])).out.trim().split('\n').pop());
                const p = h.platform;
                const plat = p.os === 'mac' ? `macos-${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : p.os === 'windows' ? 'windows-x86_64-pc-windows-msvc' : `linux-${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`;
                const { tag, assets } = await h.release('WhatsApp/erlang-language-platform');
                const builds = assets
                    .map((a) => ({ a, m: new RegExp(`^elp-${plat}-otp-(\\d+)(?:\\.\\d+)*\\.tar\\.gz$`).exec(a) }))
                    .filter((x) => x.m)
                    .map((x) => ({ asset: x.a, otp: Number(x.m[1]) }))
                    .sort((x, y) => y.otp - x.otp);
                const pick = builds.find((b) => b.otp === otp) ?? builds.find((b) => b.otp < otp) ?? builds.at(-1);
                if (!pick)
                    throw new Error(`no ELP build for ${plat}`);
                const bin = await h.fetchUnpack(`https://github.com/WhatsApp/erlang-language-platform/releases/download/${tag}/${pick.asset}`, pick.asset, exe('elp'));
                return { version: `${tag} (OTP ${pick.otp})`, bin };
            },
        },
    },
    {
        id: 'gleam',
        name: 'Gleam',
        languages: ext({ gleam: ['.gleam'] }),
        bin: 'gleam',
        args: ['lsp'],
        install: {
            kind: 'github',
            repo: 'gleam-lang/gleam',
            asset: (p, v) => `gleam-v${v}-${p.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${p.os === 'mac' ? 'apple-darwin' : p.os === 'windows' ? 'pc-windows-msvc' : 'unknown-linux-musl'}.${p.os === 'windows' ? 'zip' : 'tar.gz'}`,
            bin: () => exe('gleam'),
        },
    },
    {
        id: 'clojure',
        name: 'Clojure (clojure-lsp)',
        languages: ext({ clojure: ['.clj', '.cljs', '.cljc', '.edn'] }),
        bin: 'clojure-lsp',
        args: [],
        install: { kind: 'github', repo: 'clojure-lsp/clojure-lsp', asset: (p) => (p.os === 'windows' && p.arch === 'arm64' ? undefined : `clojure-lsp-native-${p.os === 'mac' ? 'macos' : p.os}-${p.arch === 'arm64' ? 'aarch64' : 'amd64'}.zip`), bin: () => exe('clojure-lsp') },
    },
    {
        id: 'dart',
        name: 'Dart / Flutter',
        languages: ext({ dart: ['.dart'] }),
        bin: 'dart',
        args: ['language-server', '--protocol=lsp'],
        install: {
            kind: 'custom',
            // The Dart SDK (its language server is built in), about 230 MB. Flutter users have one already.
            run: async (_dir, h) => {
                const v = (await (await fetch('https://storage.googleapis.com/dart-archive/channels/stable/release/latest/VERSION')).json()).version;
                const asset = `dartsdk-${h.platform.os === 'mac' ? 'macos' : h.platform.os}-${h.platform.arch}-release.zip`;
                const bin = await h.fetchUnpack(`https://storage.googleapis.com/dart-archive/channels/stable/release/${v}/sdk/${asset}`, asset, `dart-sdk/bin/${exe('dart')}`);
                return { version: v, bin };
            },
        },
    },
    { id: 'elm', name: 'Elm', languages: ext({ elm: ['.elm'] }), bin: 'elm-language-server', args: ['--stdio'], install: { kind: 'npm', packages: ['@elm-tooling/elm-language-server'] } },
    {
        id: 'nim',
        name: 'Nim (nimlangserver)',
        languages: ext({ nim: ['.nim', '.nims', '.nimble'] }),
        bin: 'nimlangserver',
        args: [],
        needs: ['nim'],
        install: {
            kind: 'github',
            repo: 'nim-lang/langserver',
            asset: (p) => (p.os === 'mac' ? 'nimlangserver-macos-universal.zip' : p.os === 'windows' ? (p.arch === 'x64' ? 'nimlangserver-windows-amd64.zip' : undefined) : `nimlangserver-linux-${p.arch === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`),
            bin: () => exe('nimlangserver'),
        },
    },
    { id: 'fortran', name: 'Fortran (fortls)', languages: ext({ fortran: ['.f', '.for', '.f90', '.f95', '.f03', '.f08', '.F', '.F90'] }), bin: 'fortls', args: [], install: { kind: 'pip', packages: ['fortls'] } },
    { id: 'svelte', name: 'Svelte', languages: ext({ svelte: ['.svelte'] }), bin: 'svelteserver', args: ['--stdio'], install: { kind: 'npm', packages: ['svelte-language-server'] } },
    { id: 'vue', name: 'Vue', languages: ext({ vue: ['.vue'] }), bin: 'vue-language-server', args: ['--stdio'], install: { kind: 'npm', packages: ['@vue/language-server', 'typescript'] }, initOptions: () => ({ typescript: { tsdk: path.join(lspDir('vue'), 'node_modules', 'typescript', 'lib') } }) },
    { id: 'bash', name: 'Bash / shell scripts', languages: ext({ shellscript: ['.sh', '.bash', '.zsh', '.ksh'] }), bin: 'bash-language-server', args: ['start'], install: { kind: 'npm', packages: ['bash-language-server'] } },
    {
        id: 'powershell',
        name: 'PowerShell (PowerShell Editor Services)',
        languages: ext({ powershell: ['.ps1', '.psm1', '.psd1'] }),
        bin: 'pwsh',
        args: [],
        needs: ['pwsh'],
        install: { kind: 'github', repo: 'PowerShell/PowerShellEditorServices', asset: () => 'PowerShellEditorServices.zip', bin: () => 'PowerShellEditorServices/Start-EditorServices.ps1' },
        wrapped: true,
        launch: () => {
            const own = ownBin(serverById('powershell'));
            const pwsh = onPath('pwsh');
            if (!own || !pwsh)
                return undefined;
            const q = (s) => `'${s.replace(/'/g, "''")}'`;
            return {
                command: pwsh,
                args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& ${q(own.bin)} -BundledModulesPath ${q(own.dir)} -LogPath ${q(path.join(own.dir, 'pses.log'))} -SessionDetailsPath ${q(path.join(own.dir, 'session.json'))} -FeatureFlags @() -AdditionalModules @() -HostName rein -HostProfileId rein -HostVersion 1.0.0 -Stdio -LogLevel Warning`],
                where: 'rein',
            };
        },
    },
    { id: 'html', dir: 'vscode-langservers', name: 'HTML', languages: ext({ html: ['.html', '.htm'] }), bin: 'vscode-html-language-server', args: ['--stdio'], install: { kind: 'npm', packages: ['vscode-langservers-extracted'] } },
    { id: 'css', dir: 'vscode-langservers', name: 'CSS / SCSS / Less', languages: ext({ css: ['.css'], scss: ['.scss'], less: ['.less'] }), bin: 'vscode-css-language-server', args: ['--stdio'], install: { kind: 'npm', packages: ['vscode-langservers-extracted'] } },
    { id: 'json', dir: 'vscode-langservers', name: 'JSON', languages: ext({ json: ['.json'], jsonc: ['.jsonc'] }), bin: 'vscode-json-language-server', args: ['--stdio'], install: { kind: 'npm', packages: ['vscode-langservers-extracted'] } },
    { id: 'yaml', name: 'YAML', languages: ext({ yaml: ['.yaml', '.yml'] }), bin: 'yaml-language-server', args: ['--stdio'], install: { kind: 'npm', packages: ['yaml-language-server'] } },
    {
        id: 'toml',
        name: 'TOML (taplo)',
        languages: ext({ toml: ['.toml'] }),
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
        languages: ext({ markdown: ['.md', '.markdown'] }),
        bin: 'marksman',
        args: ['server'],
        install: { kind: 'github', repo: 'artempyanykh/marksman', asset: (p) => (p.os === 'mac' ? 'marksman-macos' : p.os === 'windows' ? (p.arch === 'x64' ? 'marksman.exe' : undefined) : `marksman-linux-${p.arch}`), bin: () => exe('marksman') },
    },
    // sqls: completion and hover; its diagnostics need a database connection (.sqls config).
    { id: 'sql', name: 'SQL (sqls)', languages: ext({ sql: ['.sql'] }), bin: 'sqls', args: [], install: { kind: 'go', module: 'github.com/sqls-server/sqls' } },
    { id: 'dockerfile', name: 'Dockerfile', languages: { Dockerfile: 'dockerfile', Containerfile: 'dockerfile', '.dockerfile': 'dockerfile' }, bin: 'docker-langserver', args: ['--stdio'], install: { kind: 'npm', packages: ['dockerfile-language-server-nodejs'] } },
    {
        id: 'cmake',
        name: 'CMake (neocmakelsp)',
        languages: { 'CMakeLists.txt': 'cmake', '.cmake': 'cmake' },
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
    {
        id: 'terraform',
        name: 'Terraform (terraform-ls)',
        languages: ext({ terraform: ['.tf', '.tfvars'] }),
        bin: 'terraform-ls',
        args: ['serve'],
        install: {
            kind: 'custom',
            // HashiCorp publishes it on releases.hashicorp.com, not GitHub.
            run: async (_dir, h) => {
                const v = (await (await fetch('https://checkpoint-api.hashicorp.com/v1/check/terraform-ls')).json()).current_version;
                const asset = `terraform-ls_${v}_${h.platform.os === 'mac' ? 'darwin' : h.platform.os}_${h.platform.arch === 'arm64' ? 'arm64' : 'amd64'}.zip`;
                const bin = await h.fetchUnpack(`https://releases.hashicorp.com/terraform-ls/${v}/${asset}`, asset, exe('terraform-ls'));
                return { version: v, bin };
            },
        },
    },
    {
        id: 'nix',
        name: 'Nix (nil)',
        languages: ext({ nix: ['.nix'] }),
        bin: 'nil',
        alternatives: ['nixd'],
        args: [],
        needs: ['nix'],
        install: {
            kind: 'custom',
            // Built by Nix itself; the out-link in Rein's folder keeps it from being garbage-collected.
            run: async (dir, h) => {
                const r = await h.run('nix', ['--extra-experimental-features', 'nix-command flakes', 'build', 'nixpkgs#nil', '--out-link', path.join(dir, 'result')]);
                if (!r.ok)
                    throw new Error(r.out);
                return { version: 'nixpkgs', bin: path.join(dir, 'result', 'bin', 'nil') };
            },
        },
    },
];
/** The server for a file: by exact name (Dockerfile, CMakeLists.txt), then extension (case-sensitive first: `.S`, `.R`). */
export const serverFor = (file) => {
    const base = path.basename(file);
    const extension = path.extname(file);
    return SERVERS.find((s) => base in s.languages) ?? SERVERS.find((s) => extension in s.languages) ?? SERVERS.find((s) => extension.toLowerCase() in s.languages);
};
export const languageIdFor = (spec, file) => spec.languages[path.basename(file)] ?? spec.languages[path.extname(file)] ?? spec.languages[path.extname(file).toLowerCase()] ?? 'plaintext';
export const serverById = (id) => SERVERS.find((s) => s.id === id);
export const lspDir = (id) => path.join(reinHome(), 'lsp', id);
const dirOf = (spec) => lspDir(spec.dir ?? spec.id);
/** File patterns for a server's languages (for `git grep`). */
export const filePatterns = (spec) => Object.keys(spec.languages).map((k) => (k.startsWith('.') ? `*${k}` : k));
/**
 * A real Java: JAVA_HOME, macOS's java_home, Homebrew's (keg-only) OpenJDK, then the PATH.
 * macOS's /usr/bin/java is a stub that only says "no Java runtime" when there is none.
 */
export function javaCmd() {
    const j = exe('java');
    if (process.env.JAVA_HOME && existsSync(path.join(process.env.JAVA_HOME, 'bin', j)))
        return path.join(process.env.JAVA_HOME, 'bin', j);
    if (process.platform === 'darwin') {
        try {
            const home = execFileSync('/usr/libexec/java_home', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            if (home && existsSync(path.join(home, 'bin', 'java')))
                return path.join(home, 'bin', 'java');
        }
        catch { }
        for (const b of ['/opt/homebrew/opt/openjdk/bin/java', '/usr/local/opt/openjdk/bin/java'])
            if (existsSync(b))
                return b;
        return undefined;
    }
    return onPath('java');
}
/** The environment for tools that need Java (JAVA_HOME pointing at the one javaCmd found). */
export const javaEnv = () => {
    const j = javaCmd();
    return j ? { ...process.env, JAVA_HOME: path.dirname(path.dirname(j)), PATH: `${path.dirname(j)}${path.delimiter}${process.env.PATH ?? ''}` } : process.env;
};
const hasRuntime = (cmd) => (cmd === 'java' ? !!javaCmd() : !!onPath(cmd));
export function onPath(bin) {
    const exts = isWindows ? ['.cmd', '.exe', ''] : [''];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir)
            continue;
        for (const e of exts) {
            const p = path.join(dir, bin + e);
            if (existsSync(p))
                return p;
        }
    }
    return undefined;
}
/** Rein's own install of a server (folder and executable), for launch hooks. */
export function ownBin(spec) {
    const info = installedInfo(spec);
    if (!info?.bin)
        return undefined;
    const dir = dirOf(spec);
    const bin = path.isAbsolute(info.bin) ? info.bin : path.join(dir, info.bin);
    return existsSync(bin) ? { dir, bin } : undefined;
}
function installedInfo(spec) {
    try {
        return JSON.parse(readFileSync(path.join(dirOf(spec), 'installed.json'), 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Where Rein's own install of a server keeps its executable (undefined = none). */
function ownInstall(spec) {
    const dir = dirOf(spec);
    const i = spec.install;
    const first = (...ps) => ps.find((p) => existsSync(p));
    if (i.kind === 'npm') {
        const p = nodeBin(dir, spec.bin);
        return existsSync(p) ? { command: p } : undefined;
    }
    if (i.kind === 'github' || i.kind === 'custom') {
        const own = ownBin(spec);
        return own ? { command: own.bin } : undefined;
    }
    if (i.kind === 'go') {
        const p = first(path.join(dir, 'bin', exe(spec.bin)));
        return p ? { command: p } : undefined;
    }
    if (i.kind === 'gem') {
        const p = first(path.join(dir, 'bin', spec.bin), path.join(dir, 'bin', `${spec.bin}.bat`));
        return p ? { command: p, env: { GEM_HOME: dir, GEM_PATH: [dir, process.env.GEM_PATH].filter(Boolean).join(path.delimiter) } } : undefined;
    }
    if (i.kind === 'pip') {
        const p = first(path.join(dir, 'bin', spec.bin), path.join(dir, 'Scripts', exe(spec.bin)));
        return p ? { command: p } : undefined;
    }
    if (i.kind === 'dotnet') {
        const p = first(path.join(dir, exe(spec.bin)));
        return p ? { command: p } : undefined;
    }
    return undefined;
}
/** How to start a server for a project: configured, then the spec's own choice, Rein's install, the PATH. */
export function resolveServer(spec, overrides = {}, root = process.cwd()) {
    const o = overrides[spec.id];
    if (o?.command)
        return { command: o.command, args: o.args ?? spec.args, where: 'config' };
    if (spec.launch) {
        const l = spec.launch(root);
        if (l || spec.id === 'typescript' || spec.wrapped)
            return l; // final for TypeScript and wrapped servers
    }
    const own = ownInstall(spec);
    // Java-based servers (Metals…) find the Java that javaCmd found, keg-only Homebrew one included.
    const java = spec.needs?.includes('java') ? javaEnv() : undefined;
    if (own)
        return { command: own.command, args: spec.args, env: { ...java, ...own.env }, where: 'rein' };
    for (const bin of [spec.bin, ...(spec.alternatives ?? [])]) {
        const found = onPath(bin);
        if (found)
            return { command: found, args: spec.args, where: 'path' };
    }
    return undefined;
}
/** The version Rein installed, if it installed this server. */
export function installedVersion(spec) {
    return installedInfo(spec)?.version;
}
const TOOL = { npm: 'npm', go: 'go', gem: 'gem', dotnet: 'dotnet', pip: 'python3' };
/** Can Rein install this server on this machine? The reason when it can't. */
export function installable(spec) {
    const i = spec.install;
    if (i.kind === 'manual')
        return { ok: false, why: i.hint };
    if (spec.needs && !spec.needs.some(hasRuntime))
        return { ok: false, why: `it needs ${spec.needs.join(' or ')} on the PATH (the ${spec.name.split(' (')[0]} toolchain), which isn't there.` };
    if (i.kind === 'github' && !i.asset(platform(), '0'))
        return { ok: false, why: `there's no prebuilt ${spec.name} for ${process.platform}/${process.arch}; install it yourself and put ${spec.bin} on the PATH.` };
    const tool = TOOL[i.kind];
    if (tool && !onPath(tool) && !(tool === 'python3' && onPath('python')))
        return { ok: false, why: `installing it needs ${tool}, which isn't on the PATH.` };
    return { ok: true };
}
function runTool(command, args, cwd, env = process.env) {
    return new Promise((resolve) => {
        let out = '';
        // No stdin: installers never prompt, and a server run to warm up sees EOF and exits.
        const child = spawn(command, args, { cwd, env, shell: isWindows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (d) => (out += d));
        child.stderr?.on('data', (d) => (out += d));
        child.on('error', (err) => resolve({ ok: false, out: err.message }));
        child.on('close', (code) => resolve({ ok: code === 0, out: out.trim().slice(-1500) }));
    });
}
/** Unpack a downloaded release file into `dir`: archives with tar (zip too, except GNU tar), .gz with zlib, else as is. */
export async function unpack(file, asset, dir, bin) {
    const zip = /\.(zip|sit)$/.test(asset); // .sit: JetBrains' name for a zip on macOS
    if (/\.(tar\.gz|tgz|tar\.xz)$/.test(asset) || (zip && process.platform !== 'linux')) {
        const r = await runTool('tar', ['-xf', file, '-C', dir], dir);
        if (!r.ok)
            throw new Error(`couldn't unpack ${asset}: ${r.out}`);
    }
    else if (zip) {
        // GNU tar can't read zip: unzip, else Python's zipfile.
        const r = (await runTool('unzip', ['-q', '-o', file, '-d', dir], dir)).ok || (await runTool('python3', ['-m', 'zipfile', '-e', file, dir], dir)).ok;
        if (!r)
            throw new Error(`couldn't unpack ${asset}: install unzip`);
    }
    else if (asset.endsWith('.gz')) {
        await pipeline(createReadStream(file), createGunzip(), createWriteStream(path.join(dir, bin)));
    }
    else
        copyFileSync(file, path.join(dir, bin));
    const target = path.join(dir, bin);
    if (!existsSync(target))
        throw new Error(`${bin} wasn't in ${asset} (found: ${readdirSync(dir).join(', ')})`);
    if (!isWindows)
        chmodSync(target, 0o755);
}
/** A file by name anywhere in `dir` (a few levels down): archives whose layout changes between releases. */
export function findFile(dir, name, depth = 4) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return undefined;
    }
    for (const e of entries)
        if (e.name === name && !e.isDirectory())
            return path.join(dir, e.name);
    if (depth <= 0)
        return undefined;
    for (const e of entries)
        if (e.isDirectory()) {
            const f = findFile(path.join(dir, e.name), name, depth - 1);
            if (f)
                return f;
        }
    return undefined;
}
async function latestRelease(repo) {
    const rel = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'rein-harness' } });
    if (!rel.ok)
        throw new Error(`couldn't read ${repo}'s latest release (HTTP ${rel.status})`);
    const j = (await rel.json());
    return { tag: j.tag_name, assets: (j.assets ?? []).map((a) => a.name) };
}
/** Download to a temp file, unpack into `dir`, return the path of `bin` there (searched for by name if the layout moved). */
async function fetchUnpack(url, asset, dir, bin) {
    const res = await fetch(url);
    if (!res.ok || !res.body)
        throw new Error(`download of ${asset} failed (HTTP ${res.status})`);
    const file = path.join(os.tmpdir(), `rein-lsp-${process.pid}-${Date.now()}-${path.basename(asset)}`);
    try {
        await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
        try {
            await unpack(file, asset, dir, bin);
            return path.join(dir, bin);
        }
        catch (err) {
            const found = findFile(dir, path.basename(bin));
            if (!found)
                throw err;
            if (!isWindows)
                chmodSync(found, 0o755);
            return found;
        }
    }
    finally {
        rmSync(file, { force: true });
    }
}
async function installGithub(spec, i, dir) {
    const { tag } = await latestRelease(i.repo);
    const version = tag.replace(/^v/, '');
    const asset = i.asset(platform(), version);
    if (!asset)
        throw new Error(`there's no prebuilt ${spec.name} for ${process.platform}/${process.arch}`);
    const res = await fetch(`https://github.com/${i.repo}/releases/download/${tag}/${asset}`);
    if (!res.ok || !res.body)
        throw new Error(`download of ${asset} failed (HTTP ${res.status})`);
    // Unpack into a fresh folder, then swap: a failed update keeps the old server.
    const fresh = `${dir}.new`;
    rmSync(fresh, { recursive: true, force: true });
    mkdirSync(fresh, { recursive: true });
    const file = path.join(os.tmpdir(), `rein-lsp-${process.pid}-${asset}`);
    try {
        await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
        const bin = i.bin(version);
        await unpack(file, asset, fresh, bin);
        rmSync(dir, { recursive: true, force: true });
        renameSync(fresh, dir);
        return { version, bin };
    }
    finally {
        rmSync(file, { force: true });
        rmSync(fresh, { recursive: true, force: true });
    }
}
/**
 * Install a server into Rein's folder (the latest version). Returns what happened. The agent's
 * `lsp_install` tool is the only caller, and it always asks the user first.
 */
export async function installServer(spec) {
    const can = installable(spec);
    if (!can.ok)
        return { ok: false, text: `Rein can't install ${spec.name} itself: ${can.why}` };
    const dir = dirOf(spec);
    const i = spec.install;
    try {
        let version = 'latest';
        let bin;
        if (i.kind === 'github')
            ({ version, bin } = await installGithub(spec, i, dir));
        else if (i.kind === 'custom') {
            const fresh = `${dir}.new`;
            rmSync(fresh, { recursive: true, force: true });
            mkdirSync(fresh, { recursive: true });
            try {
                const helpers = {
                    run: (command, args, env) => runTool(command, args, fresh, env ?? process.env),
                    release: latestRelease,
                    fetchUnpack: (url, asset, b) => fetchUnpack(url, asset, fresh, b),
                    platform: platform(),
                };
                const r = await i.run(fresh, helpers);
                version = r.version;
                // Paths inside the fresh folder become relative (it's renamed); others stay absolute.
                bin = path.isAbsolute(r.bin) && r.bin.startsWith(fresh + path.sep) ? path.relative(fresh, r.bin) : r.bin;
                rmSync(dir, { recursive: true, force: true });
                renameSync(fresh, dir);
            }
            finally {
                rmSync(fresh, { recursive: true, force: true });
            }
        }
        else {
            mkdirSync(dir, { recursive: true });
            let r = { ok: false, out: '' };
            if (i.kind === 'npm') {
                if (!existsSync(path.join(dir, 'package.json')))
                    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `rein-lsp-${spec.id}`, private: true }));
                r = await runTool(isWindows ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...i.packages], dir);
                try {
                    version = JSON.parse(readFileSync(path.join(dir, 'node_modules', i.packages[0], 'package.json'), 'utf8')).version;
                }
                catch { }
            }
            else if (i.kind === 'go')
                r = await runTool('go', ['install', `${i.module}@latest`], dir, { ...process.env, GOBIN: path.join(dir, 'bin') });
            else if (i.kind === 'gem')
                r = await runTool('gem', ['install', i.gem, '--install-dir', dir, '--bindir', path.join(dir, 'bin'), '--no-document'], dir);
            else if (i.kind === 'dotnet')
                r = await runTool('dotnet', ['tool', 'install', i.tool, '--tool-path', dir], dir);
            else if (i.kind === 'pip') {
                const py = onPath('python3') ? 'python3' : 'python';
                r = await runTool(py, ['-m', 'venv', dir], dir);
                const pip = isWindows ? path.join(dir, 'Scripts', 'pip.exe') : path.join(dir, 'bin', 'pip');
                if (r.ok)
                    r = await runTool(pip, ['install', '--disable-pip-version-check', '-q', ...i.packages], dir);
            }
            if (!r.ok)
                return { ok: false, text: `Installing ${spec.name} failed:\n${r.out}` };
        }
        writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ id: spec.id, version, bin, at: new Date().toISOString() }));
        if (!ownInstall(spec))
            return { ok: false, text: `Installed, but ${spec.bin} isn't where Rein expected it in ${dir}.` };
        return { ok: true, text: `Installed ${spec.name} ${version} into ${dir}.` };
    }
    catch (err) {
        return { ok: false, text: `Installing ${spec.name} failed: ${err.message}` };
    }
}
