#!/usr/bin/env node
/**
 * Bundles Rein after tsc has built dist/. Node spends most of an unbundled start resolving, reading
 * and compiling the ~1,500 small files of Ink, React and the rest (over 2 s on a slower Mac); a
 * bundle starts several times faster. dist/cli.js becomes a small launcher that turns on Node's
 * compile cache and loads dist/bundle/rein.js. Code that's loaded with import() (PDF reading, the
 * modes other than the TUI) is split into chunks loaded only when used. The rest of tsc's dist/
 * tree stays, for the files Rein runs as separate processes (dist/tools/mcpProxy.js).
 */
import {readFile, rm, writeFile} from 'node:fs/promises';
import {build} from 'esbuild';

/** Ink's devtools (dev mode only) import react-devtools-core, which isn't installed. */
const noDevtools = {
  name: 'no-devtools',
  setup(b) {
    b.onResolve({filter: /^react-devtools-core$/}, () => ({path: 'react-devtools-core', namespace: 'stub'}));
    b.onLoad({filter: /.*/, namespace: 'stub'}, () => ({contents: 'export default {connectToDevTools() {}};', loader: 'js'}));
  },
};

/**
 * React's packages pick their production or development build from NODE_ENV when loaded; Rein
 * always runs production (see src/cli.ts), so the development builds are left out of the bundle.
 */
const reactProduction = {
  name: 'react-production',
  setup(b) {
    b.onLoad({filter: /[\\/]node_modules[\\/](react|react-reconciler|scheduler)[\\/][\w-]+\.js$/}, async (args) => ({
      contents: (await readFile(args.path, 'utf8')).replaceAll("process.env.NODE_ENV === 'production'", 'true'),
      loader: 'js',
    }));
  },
};

/**
 * Ink caches each line's parsed ANSI and each string's width, but per frame: every render makes a
 * new Output and so a new, empty cache, and re-parses every character on screen. With a long
 * conversation on screen that was a quarter of a core just to animate the working line. One cache
 * shared across frames (emptied when it grows large) parses only what changed.
 */
const inkSharedCaches = {
  name: 'ink-shared-caches',
  setup(b) {
    // string-width segments graphemes and tests each for emoji: the costliest call in a frame, and
    // made for the same strings every frame (widest-line, cli-truncate, Rein's own wrapping too).
    b.onLoad({filter: /[\\/]node_modules[\\/]string-width[\\/]index\.js$/}, async (args) => {
      const src = await readFile(args.path, 'utf8');
      const patched = src.replace('export default function stringWidth(input, options = {}) {', 'function stringWidthUncached(input, options = {}) {');
      if (patched === src) throw new Error(`ink-shared-caches: string-width changed (${args.path}); update scripts/bundle.mjs`);
      return {
        contents: `${patched}
let widths = new Map();
export default function stringWidth(input, options) {
    if (options !== undefined || typeof input !== 'string') return stringWidthUncached(input, options);
    let w = widths.get(input);
    if (w === undefined) {
        if (widths.size > 20000) widths = new Map();
        w = stringWidthUncached(input);
        widths.set(input, w);
    }
    return w;
}
`,
        loader: 'js',
      };
    });
    b.onLoad({filter: /[\\/]ink[\\/]build[\\/]output\.js$/}, async (args) => {
      const src = await readFile(args.path, 'utf8');
      const patched = src
        .replace('    caches = new OutputCaches();', '    caches = sharedCaches();')
        .replace('return sliceAnsi(line, from, to);', 'return this.caches.getSlice(line, from, to);');
      if (!patched.includes('sharedCaches()') || !patched.includes('getSlice(')) throw new Error(`ink-shared-caches: Ink's output.js changed (${args.path}); update scripts/bundle.mjs`);
      return {
        contents: `${patched}
const slices = new Map();
OutputCaches.prototype.getSlice = function (line, from, to) {
    const key = from + ':' + to + ':' + line;
    let cached = slices.get(key);
    if (cached === undefined) {
        if (slices.size > 20000) slices.clear();
        cached = sliceAnsi(line, from, to);
        slices.set(key, cached);
    }
    return cached;
};
let shared;
function sharedCaches() {
    if (!shared || shared.styledChars.size + shared.widths.size > 20000) shared = new OutputCaches();
    return shared;
}
`,
        loader: 'js',
      };
    });
  },
};

/** ui/resizeFix.ts needs Ink's own instances map; with Ink inlined, the file on disk would be a second copy. */
const inkInstances = {
  name: 'ink-instances',
  setup(b) {
    b.onLoad({filter: /[\\/]ink[\\/]build[\\/]instances\.js$/}, async (args) => ({
      contents: `${await readFile(args.path, 'utf8')}\nglobalThis.__reinInkInstances = instances;\n`,
      loader: 'js',
    }));
  },
};

await rm('dist/bundle', {recursive: true, force: true});
await build({
  entryPoints: {rein: 'dist/cli.js'},
  outdir: 'dist/bundle',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Native or binary-locating packages stay in node_modules: ripgrep finds its binary next to itself,
  // node-pty loads its platform's prebuilt binary.
  external: ['@vscode/ripgrep', '@lydell/node-pty'],
  // CommonJS packages inside an ES module bundle still need require().
  banner: {js: "import {createRequire as __reinRequire} from 'node:module';\nconst require = __reinRequire(import.meta.url);"},
  plugins: [noDevtools, reactProduction, inkInstances, inkSharedCaches],
  logLevel: 'warning',
});

// The launcher: the compile cache (Node 22.1+) must be on before the bundle is loaded to cover it.
await writeFile(
  'dist/cli.js',
  `#!/usr/bin/env node
// Built by scripts/bundle.mjs: Rein itself is dist/bundle/rein.js.
import module from 'node:module';
module.enableCompileCache?.();
await import('./bundle/rein.js');
`,
);
