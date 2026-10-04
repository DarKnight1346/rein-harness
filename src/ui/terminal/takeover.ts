import type {Shell, ShellManager} from '../../tools/shells.js';
import {inkFrame, redrawAfterTakeover} from '../resizeFix.js';
import {MOUSE_OFF, MOUSE_ON} from './mouse.js';

/** Ctrl+] hands the terminal back to Rein (the command keeps running). */
export const DETACH = '\x1d';

/**
 * A command waiting for the user gets the real terminal, like Ctrl+G hands it to the editor: Rein
 * stops drawing, keystrokes go straight to the command (Esc and Ctrl+C included), its output goes
 * straight to the screen, and full-screen programs redraw at the terminal's size. Nothing is
 * emulated, so prompts, colours, vim and password entry behave exactly as in a normal terminal.
 *
 * It ends when the command exits or the user presses Ctrl+]; then Rein's screen comes back as it
 * was. Returns a function that ends it early (the agent was interrupted).
 */
export function takeOver(shells: ShellManager, shell: Shell, opts: {fullscreen: boolean; label?: string; onEnd(reason: 'exit' | 'detach'): void}): () => void {
  const out = process.stdout;
  const stdin = process.stdin;
  const original = out.write;
  const write = (s: string) => original.call(out, s);
  const frame = opts.fullscreen ? '' : inkFrame(out);
  // Rein stops drawing: Ink's frames are dropped until we hand back.
  out.write = (() => true) as typeof out.write;
  // Rein stops listening: Ink (classic) reads with 'readable', the fullscreen mouse reader with 'data'.
  const saved = {data: stdin.listeners('data'), readable: stdin.listeners('readable')};
  stdin.removeAllListeners('data');
  stdin.removeAllListeners('readable');
  // Classic: an alternate screen keeps the transcript as it was. Kitty keys and mouse reports off:
  // the command expects plain terminal input.
  write((opts.fullscreen ? MOUSE_OFF + '\x1b[2J\x1b[H' : '\x1b[?1049h\x1b[2J\x1b[H') + '\x1b[<u\x1b[?25h');
  const who = opts.label ? `${opts.label} · ` : '';
  write(`\x1b[7m ${who}$ ${shell.command.replace(/\s+/g, ' ').slice(0, Math.max(10, (out.columns ?? 80) - 40))} is waiting for you · Ctrl+] back to Rein \x1b[0m\r\n`);
  write(shells.screen(shell.id));
  const onData = (d: Buffer | string) => {
    const s = d.toString();
    const i = s.indexOf(DETACH);
    if (i < 0) return void shells.write(shell.id, s);
    if (i > 0) shells.write(shell.id, s.slice(0, i));
    end('detach');
  };
  const onOutput = (s: Shell, d: string) => {
    if (s.id === shell.id) write(d);
  };
  const onChange = (s: Shell) => {
    if (s.id === shell.id && s.status !== 'running') end('exit');
  };
  const onResize = () => shells.resize(shell.id, out.columns ?? 80, out.rows ?? 24);
  stdin.on('data', onData);
  shells.on('data', onOutput);
  shells.on('change', onChange);
  out.on('resize', onResize);
  // Full-screen programs redraw for the real size (and anything drawn before we took over).
  onResize();
  let ended = false;
  function end(reason: 'exit' | 'detach') {
    if (ended) return;
    ended = true;
    stdin.removeListener('data', onData);
    shells.removeListener('data', onOutput);
    shells.removeListener('change', onChange);
    out.removeListener('resize', onResize);
    stdin.pause();
    for (const l of saved.readable) stdin.on('readable', l as () => void);
    for (const l of saved.data) stdin.on('data', l as (d: Buffer) => void);
    if (saved.data.length && !saved.readable.length) stdin.resume(); // the fullscreen reader is a 'data' listener
    out.write = original;
    write((opts.fullscreen ? '\x1b[2J\x1b[H' + MOUSE_ON : '\x1b[?1049l') + '\x1b[>1u');
    redrawAfterTakeover(out, frame);
    opts.onEnd(reason);
  }
  if (shell.status !== 'running') end('exit');
  return () => end('detach');
}
