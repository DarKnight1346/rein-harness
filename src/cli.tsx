#!/usr/bin/env node
import React from 'react';
import {render, type RenderOptions} from 'ink';
import {loadConfig} from './store/config.js';
import {ClassicApp} from './ui/ClassicApp.js';
import {FullscreenApp, lastEntries} from './ui/fullscreen/FullscreenApp.js';
import {entryLines} from './ui/fullscreen/lines.js';
import {installResizeFix, setResizeMode} from './ui/resizeFix.js';
import {ClickProvider} from './ui/terminal/clicks.js';
import {installTerminalRestore, MOUSE_OFF, MOUSE_ON, MouseStdin} from './ui/terminal/mouse.js';
import type {ExitResult, Renderer} from './ui/useRein.js';
import type {Resume} from './runtime.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: rein [--continue|-c] [--classic|--fullscreen]

  -c, --continue [id]   pick a saved conversation from this project to continue (or continue <id>)
  --classic        inline renderer (native scrollback, no mouse)
  --fullscreen     app-style renderer: top bar, sidebar, mouse clicks (default)`);
  process.exit(0);
}
if (!process.stdin.isTTY) {
  console.error('rein needs an interactive terminal.');
  process.exit(1);
}

const cfg = await loadConfig();
let renderer: Renderer = args.includes('--classic') ? 'classic' : args.includes('--fullscreen') ? 'fullscreen' : (cfg.tui ?? 'fullscreen');
const ci = args.findIndex((a) => a === '--continue' || a === '-c');
let resume: Resume = ci < 0 ? false : args[ci + 1] && !args[ci + 1]!.startsWith('-') ? args[ci + 1]! : true;
installTerminalRestore();
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
