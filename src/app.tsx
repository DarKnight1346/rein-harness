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
       rein schedule [list | run [--due | <job>] | install | uninstall]
       rein attach [id]
       rein sessions
       rein bench [init [--count n] | run --model m [--model m2] [--tasks n] [--test cmd]]
       rein --update | --version

  -c, --continue [id]   pick a saved conversation from this project to continue (or continue <id>)
  --classic        inline renderer (native scrollback, no mouse)
  --fullscreen     app-style renderer: top bar, sidebar, mouse clicks (default)
  --add-dir <path> also let the agent use this folder without asking (repeatable)
  --scope <dir>    work in one package of a monorepo: search, list and shell start there
  --background     run the session in the background: closing the terminal (or Ctrl+\\) detaches,
                   rein attach [id] comes back from any terminal
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
if (args[0] === 'host') {
  // Internal: the detached process behind `rein --background` (see host/index.ts).
  const {runHost} = await import('./host/index.js');
  const [, id, cols, rows, file, ...rest] = args;
  process.exit(await runHost({id: id!, cwd: process.cwd(), file: file!, args: rest, cols: Number(cols) || 100, rows: Number(rows) || 30}));
}
if (args[0] === 'sessions') {
  // The multi-session dashboard: every running Rein; attach loops back here after a detach.
  if (!process.stdin.isTTY) {
    const {listLive, describeLive} = await import('./host/live.js');
    const all = listLive();
    console.log(all.length ? all.map((l) => `${l.pid}\t${describeLive(l)}`).join('\n') : 'No Rein sessions running.');
    process.exit(0);
  }
  const {render} = await import('ink');
  const React = await import('react');
  const {SessionsDashboard} = await import('./ui/SessionsDashboard.js');
  const h = await import('./host/index.js');
  for (;;) {
    let choice: import('./ui/SessionsDashboard.js').DashboardChoice = {quit: true};
    const app = render(React.createElement(SessionsDashboard, {onDone: (c) => (choice = c)}));
    await app.waitUntilExit();
    if (!('attach' in choice)) break;
    const target = h.listHosts().find((x) => x.id === (choice as {attach: string}).attach);
    if (target) await h.attach(target);
  }
  process.exit(0);
}
if (args[0] === 'attach' || args.includes('--background')) {
  const h = await import('./host/index.js');
  if (!process.stdin.isTTY) {
    console.error('rein: attaching needs an interactive terminal');
    process.exit(1);
  }
  let target: import('./host/index.js').HostInfo | undefined;
  if (args.includes('--background')) {
    try {
      target = await h.startHost(process.cwd(), args.filter((a) => a !== '--background'));
    } catch (err) {
      console.error(`rein: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    const hosts = h.listHosts();
    const want = args[1];
    target = want ? hosts.find((x) => x.id === want || x.id.startsWith(want)) : hosts.filter((x) => x.cwd === process.cwd()).length === 1 ? hosts.find((x) => x.cwd === process.cwd()) : hosts.length === 1 ? hosts[0] : undefined;
    if (!target) {
      console.log(hosts.length ? `Background sessions (rein attach <id>):\n${hosts.map((x) => `  ${x.id}  ${x.cwd}  started ${new Date(x.startedAt).toLocaleString()}`).join('\n')}` : 'No background sessions. rein --background starts one.');
      process.exit(want ? 1 : 0);
    }
  }
  const how = await h.attach(target);
  console.log(how === 'exited' ? '\nThe session ended.' : `\nDetached: the session keeps running. rein attach ${target.id} comes back to it.`);
  process.exit(0);
}
if (args[0] === 'bench') {
  // Benchmarks on this repo's own history: tasks from commits, run per model, judged by the commits' tests.
  const b = await import('./insight/bench.js');
  const root = process.cwd();
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const sub = args[1] ?? 'show';
  if (sub === 'init') {
    const tasks = await b.pickTasks(root, Number(opt('--count') ?? 10));
    if (!tasks.length) {
      console.error('rein: no suitable commits (non-merge, changing code and its tests, under 400 lines)');
      process.exit(1);
    }
    console.log(`${tasks.length} tasks saved to ${b.saveTasks(root, tasks)}:\n${tasks.map((t) => `  ${t.id}  ${t.prompt.split('\n')[0]!.slice(0, 70)}  (${t.lines} lines, ${t.tests.length} test file${t.tests.length === 1 ? '' : 's'})`).join('\n')}\nEdit the file to drop or reword tasks, then: rein bench run --model <a> --model <b>`);
    process.exit(0);
  }
  if (sub === 'run') {
    const models = args.flatMap((x, i) => (x === '--model' && args[i + 1] ? [args[i + 1]!] : []));
    const tasks = b.loadTasks(root).slice(0, Number(opt('--tasks') ?? Infinity));
    if (!tasks.length) {
      console.error('rein: no tasks yet: rein bench init');
      process.exit(1);
    }
    if (!models.length) {
      console.error('rein: name the models to compare: rein bench run --model claude:opus --model codex:gpt-5.5');
      process.exit(1);
    }
    console.log(`Running ${tasks.length} task${tasks.length === 1 ? '' : 's'} × ${models.length} model${models.length === 1 ? '' : 's'} (real runs on your accounts)…`);
    const results = await b.runBench(root, tasks, models, {...(opt('--test') ? {test: opt('--test')} : {}), log: (l) => console.log(`  ${l}`)});
    console.log(`${b.formatBench(results)}\nSaved to ${b.saveResults(root, results)}`);
    process.exit(0);
  }
  const tasks = b.loadTasks(root);
  console.log(tasks.length ? `${tasks.length} bench tasks in .rein/bench/tasks.json. rein bench run --model <a> --model <b> compares models on them.` : 'No bench tasks yet: rein bench init picks them from this repo\'s history.');
  process.exit(0);
}
if (args[0] === 'schedule') {
  // Scheduled jobs (.rein/schedule.yaml): list, run (due ones, or one by name), install / uninstall the OS entry.
  const s = await import('./schedule/index.js');
  const [, sub = 'list', name] = args;
  const {jobs, errors} = s.loadJobs(process.cwd());
  for (const e of errors) console.error(`rein: ${e}`);
  if (sub === 'run') {
    const picked = args.includes('--due') ? undefined : jobs.filter((j) => !name || j.name === name);
    if (picked && name && !picked.length) {
      console.error(`rein: no job "${name}" in .rein/schedule.yaml`);
      process.exit(1);
    }
    const ran = picked ? await Promise.all(picked.map(async (j) => ({job: j, state: await s.runJob(j)}))) : await s.runDue(process.cwd());
    for (const r of ran) console.log(`${r.job.name} (${r.job.project}): ${r.state.lastExit === 0 ? 'ok' : `exit ${r.state.lastExit}`} · log ${r.state.lastLog}`);
    process.exit(ran.some((r) => r.state.lastExit !== 0) ? 1 : 0);
  }
  if (sub === 'install') {
    if (!jobs.length) {
      console.error('rein: no jobs in .rein/schedule.yaml to schedule');
      process.exit(1);
    }
    console.log(await s.install(process.cwd()));
    process.exit(0);
  }
  if (sub === 'uninstall') {
    console.log(await s.uninstall(process.cwd()));
    process.exit(0);
  }
  console.log(jobs.length ? `Jobs in .rein/schedule.yaml:\n${s.describeJobs(jobs)}${s.scheduledProjects().includes(process.cwd()) ? '' : '\nNot installed: rein schedule install runs them on time.'}` : 'No jobs in .rein/schedule.yaml.');
  process.exit(errors.length ? 1 : 0);
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
// --scope <dir>: work in one package of a monorepo (search, list, shell and instructions start there).
{
  const i = args.indexOf('--scope');
  if (i >= 0 && args[i + 1]) {
    const {runtime} = await import('./runtime.js');
    try {
      runtime.setScope(args[i + 1]);
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
  // Event types: the release of Ctrl+Space ends a push-to-talk recording (other releases are
  // dropped before Ink sees them, in MouseStdin).
  kittyKeyboard: {mode: 'auto', flags: ['disambiguateEscapeCodes', 'reportEventTypes']},
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
    const stdin = new MouseStdin(process.stdin); // Ctrl+Space and key releases (no mouse in classic)
    const app = render(<ClassicApp resume={resume} />, {...base, stdin: stdin as unknown as NodeJS.ReadStream});
    result = (await app.waitUntilExit()) as ExitResult | undefined;
    process.stdin.removeAllListeners('data');
  }
  if (!result?.switchTo) break;
  renderer = result.switchTo;
  resume = result.sessionId ?? false; // carry the conversation into the other renderer
}
// Child CLIs (codex app-servers) must not keep the process alive.
process.exit(0);
