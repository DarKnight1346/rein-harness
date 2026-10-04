import React from 'react';
import {render, type RenderOptions} from 'ink';
import {appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {loadConfig} from './store/config.js';
import {paths} from './store/paths.js';
import {ClassicApp} from './ui/ClassicApp.js';
import {FullscreenApp, lastEntries} from './ui/fullscreen/FullscreenApp.js';
import {entryLines} from './ui/fullscreen/lines.js';
import {installResizeFix, setResizeMode, ensureTerminalSize} from './ui/resizeFix.js';
import {ClickProvider} from './ui/terminal/clicks.js';
import {installTerminalRestore, MOUSE_OFF, MOUSE_ON, MouseStdin} from './ui/terminal/mouse.js';
import type {ExitResult, Renderer} from './ui/useRein.js';
import type {Resume} from './runtime.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: rein [--continue|-c] [--classic|--fullscreen]
       rein -p "<prompt>" [--model m] [--output-format text|json|stream-json]
       rein --update | --version

  -c, --continue [id]   pick a saved conversation from this project to continue (or continue <id>)
  --classic        inline renderer (native scrollback, no mouse)
  --fullscreen     app-style renderer: top bar, sidebar, mouse clicks (default)
  --add-dir <path> also let the agent use this folder without asking (repeatable)
  -p, --print      headless: run one prompt (or stdin) and print the result; also --model,
                   --effort, --output-format, --permission-mode ask|auto|bypass,
                   --allowedTools "shell(npm test:*),edit(src/**)", --disallowedTools, --verbose
  --update         update Rein (latest from npm) and the claude / codex CLIs, then exit
  -v, --version    print Rein's version`);
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  const {reinVersion} = await import('./commands/update.js');
  console.log(reinVersion());
  process.exit(0);
}
if (args.includes('--update')) {
  // Same steps as /update, printed to the terminal (no UI, no TTY needed).
  const {runUpdate} = await import('./commands/update.js');
  const chalk = (await import('chalk')).default;
  const color = {ok: chalk.green, warn: chalk.yellow, error: chalk.red, info: chalk.cyan, output: chalk.dim} as const;
  let failed = false;
  for await (const line of runUpdate(() => {})) {
    if (line.level === 'error') failed = true;
    const text = line.level === 'info' ? `$ ${line.text}` : line.level === 'output' ? `  ${line.text}` : line.text;
    console.log(line.level ? color[line.level](text) : text);
  }
  process.exit(failed ? 1 : 0);
}
if (args.includes('-p') || args.includes('--print')) {
  // Headless: one prompt, printed result, no UI (scripts/CI).
  const {runHeadless} = await import('./headless.js');
  process.exit(await runHeadless(args));
}
if (!process.stdin.isTTY) {
  console.error('rein needs an interactive terminal (or use rein -p "…" for headless mode).');
  process.exit(1);
}

// Node prints runtime warnings (MaxListenersExceeded, perf_hooks, deprecations…) straight to the
// terminal, under Ink's feet: the frame ends up a row off and parts of it show twice. Interactive
// sessions log them to ~/.rein/state/warnings.log instead.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  try {
    mkdirSync(paths.state(), {recursive: true});
    appendFileSync(path.join(paths.state(), 'warnings.log'), `${new Date().toISOString()} ${w.name}: ${w.message}\n`);
  } catch {}
});

const cfg = await loadConfig();
let renderer: Renderer = args.includes('--classic') ? 'classic' : args.includes('--fullscreen') ? 'fullscreen' : (cfg.tui ?? 'fullscreen');
// --add-dir <path> (repeatable): extra working directories for this session, like Claude Code.
{
  const dirs = args.flatMap((a, i) => (a === '--add-dir' && args[i + 1] ? [args[i + 1]!] : []));
  if (dirs.length) {
    const {runtime} = await import('./runtime.js');
    try {
      runtime.tools.addDirs(dirs);
    } catch (err) {
      console.error(`rein: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}
const ci = args.findIndex((a) => a === '--continue' || a === '-c');
let resume: Resume = ci < 0 ? false : args[ci + 1] && !args[ci + 1]!.startsWith('-') ? args[ci + 1]! : true;
installTerminalRestore();
ensureTerminalSize(process.stdout);
await installResizeFix(process.stdout); // runs before Ink's own resize handler

// Shared render settings validated in the M0/fullscreen spikes: frame cap + incremental line diffs.
// Kitty keyboard lets terminals that support it report Shift+Enter.
const base: RenderOptions = {
  // Ctrl+C is handled by the app: first press stops the agent, a second press within 2s exits.
  exitOnCtrlC: false,
  patchConsole: false,
  maxFps: 30,
  incrementalRendering: true,
  kittyKeyboard: {mode: 'auto', flags: ['disambiguateEscapeCodes']},
};

for (;;) {
  let result: ExitResult | undefined;
  setResizeMode(renderer);
  if (renderer === 'fullscreen') {
    const stdin = new MouseStdin(process.stdin);
    const app = render(
      <ClickProvider mouse={stdin.mouse}>
        <FullscreenApp resume={resume} />
      </ClickProvider>,
      {...base, alternateScreen: true, stdin: stdin as unknown as NodeJS.ReadStream},
    );
    process.stdout.write(MOUSE_ON);
    result = (await app.waitUntilExit()) as ExitResult | undefined;
    process.stdout.write(MOUSE_OFF);
    process.stdin.removeAllListeners('data');
    // The alt screen is gone; leave the conversation in the normal terminal history.
    const width = process.stdout.columns ?? 80;
    const lines = lastEntries.current.flatMap((e) => entryLines(e, Math.max(20, width - 2)));
    if (lines.length > 2 && !result?.switchTo) process.stdout.write(lines.join('\n') + '\n\n');
  } else {
    const app = render(<ClassicApp resume={resume} />, base);
    result = (await app.waitUntilExit()) as ExitResult | undefined;
  }
  if (!result?.switchTo) break;
  renderer = result.switchTo;
  resume = result.sessionId ?? false; // carry the conversation into the other renderer
}
// Child CLIs (codex app-servers) must not keep the process alive.
process.exit(0);
