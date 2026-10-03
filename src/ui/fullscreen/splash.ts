import chalk from 'chalk';
import stringWidth from 'string-width';
import {hueHex} from '../Working.js';

/**
 * The blank-state graphic in the chat pane: the REIN wordmark under the ▁▃▅▇ bar logo, in a slowly
 * drifting rainbow, with a tagline and tips. `opacity` (0–1) blends every color with the background
 * so it can fade in at launch and out when the first message is sent.
 */
const WORDMARK = [
  '██████╗ ███████╗██╗███╗   ██╗',
  '██╔══██╗██╔════╝██║████╗  ██║',
  '██████╔╝█████╗  ██║██╔██╗ ██║',
  '██╔══██╗██╔══╝  ██║██║╚██╗██║',
  '██║  ██║███████╗██║██║ ╚████║',
  '╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝',
];
const LOGO = '▁▃▅▇▅▃▁';
const TAGLINE = 'One CLI, Every Workflow';
const TIPS = ['type a message to start', '/ for commands', '@ to attach a file', '/model to pick a model'];

/** The terminal background the colors fade from/to (Rein's dark theme). */
const BG = [0x1e, 0x1e, 0x1e];

function mix(hex: string, opacity: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return '#' + c.map((v, i) => Math.round(BG[i]! + (v - BG[i]!) * opacity).toString(16).padStart(2, '0')).join('');
}

const center = (s: string, width: number) => ' '.repeat(Math.max(0, Math.floor((width - stringWidth(s)) / 2))) + s;

/** Color each character along a diagonal rainbow that drifts with `tick`. */
function paint(text: string, row: number, tick: number, opacity: number, light = 0.62): string {
  let out = '';
  [...text].forEach((ch, col) => {
    out += ch === ' ' ? ch : chalk.hex(mix(hueHex((col * 7 + row * 9 + tick * 4) % 360, 0.75, light), opacity))(ch);
  });
  return out;
}

/** The splash, centered for `width`; a compact version on narrow panes. Height = lines.length. */
export function splashLines(width: number, opacity: number, tick: number): string[] {
  const o = Math.max(0, Math.min(1, opacity));
  const dim = (s: string) => chalk.hex(mix('#8a8a8a', o))(s);
  if (width < stringWidth(WORDMARK[0]!) + 4) {
    return [center(paint(`${LOGO}  rein`, 0, tick, o), width), '', center(dim('type a message to start · / for commands'), width)];
  }
  const tips = TIPS.join('  ·  ');
  return [
    center(paint(LOGO, 0, tick, o, 0.66), width),
    '',
    ...WORDMARK.map((l, r) => center(paint(l, r + 1, tick, o), width)),
    '',
    center(dim(TAGLINE), width),
    '',
    center(dim(stringWidth(tips) <= width ? tips : 'type a message to start · / for commands'), width),
  ];
}
