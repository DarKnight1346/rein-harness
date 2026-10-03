import chalk from 'chalk';
import cliTruncate from 'cli-truncate';
import {diffWordsWithSpace} from 'diff';
import sliceAnsi from 'slice-ansi';
import {diffStats, type DiffLine} from '../../tools/diff.js';
import {highlight, renderMarkdown} from '../markdown.js';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import {PROVIDERS} from '../../providers/types.js';
import {clock} from '../../session/engine.js';
import {windowLabel} from '../../store/usage.js';
import type {Entry} from '../entries.js';
import {accountLabel, age, approvalNote, compactText, relative, routeLabel, toolResultSummary} from '../format.js';
import {runtime} from '../../runtime.js';
import {subagentStatusText, type Subagent} from '../../agents/manager.js';
import {rainbow} from '../Working.js';

/** Wrap `text` to `width`, prefixing the first line with `first` and the rest with `rest`. */
export function wrap(text: string, width: number, first = '', rest = ' '.repeat(stringWidth(first))): string[] {
  const inner = Math.max(8, width - stringWidth(first));
  return wrapAnsi(text, inner, {hard: true, trim: false})
    .split('\n')
    .map((line, i) => (i === 0 ? first : rest) + line.replace(/ +$/, ''));
}

const gutter = (text: string, width: number, color: (s: string) => string) =>
  text.split('\n').flatMap((para, i) => wrap(para, width, i === 0 ? '  ⎿ ' : '    ', '    ')).map((l) => color(l)); // not .map(color): chalk joins extra args

/**
 * Fullscreen transcript entries → wrapped ANSI lines (the history pane virtualizes these).
 * Mirrors the classic renderer's EntryView.
 */
export function entryLines(entry: Entry, width: number): string[] {
  switch (entry.kind) {
    case 'banner':
      return [chalk.bold.cyan(`▁▃▅▇ ${entry.text}`) + chalk.dim('  /help for commands'), ''];
    case 'user':
      return ['', ...entry.text.split('\n').flatMap((p, i) => wrap(p, width, i === 0 ? chalk.gray('> ') : '  ', '  '))];
    case 'assistant':
      return assistantLines(entry.text, width, entry.first);
    case 'tool':
      return [
        '',
        // Long commands/paths wrap with a hanging indent instead of overflowing the pane.
        ...wrap(chalk.bold(entry.label) + chalk.dim(`(${entry.summary})${approvalNote(entry.approvedBy, entry.judge)}`) + diffStatText(entry.diff), width, entry.ok ? chalk.green('⏺ ') : chalk.red('⏺ '), '  '),
        ...gutter(toolResultSummary(entry.label, entry.result), width, entry.ok ? chalk.dim : chalk.red).slice(0, 1),
        ...diffLines(entry.diff, width, entry.summary),
      ];
    case 'compact': {
      const {stats, why} = compactText(entry.reason, entry.result, runtime.config.autoCompactPct);
      const title = ' Conversation compacted ';
      const logo = [...'▁▃▅▇'].map((c, i) => chalk.hex(rainbow(i * 2, 0))(c)).join('');
      const rule = Math.max(2, width - 4 - 4 - title.length);
      return [
        '',
        chalk.cyan('── ') + logo + chalk.bold.cyan(title) + chalk.cyan('─'.repeat(rule)),
        ...wrap(stats, width, '  ', '  '),
        ...wrap(why, width, '  ', '  ').map((l) => chalk.dim(l)),
      ];
    }
    case 'route':
      return wrap(chalk.dim(`→ ${routeLabel(entry.route, entry.account)}`) + (entry.interrupted ? chalk.yellow(' · interrupted') : ''), width, '  ', '    ');
    case 'info':
      return gutter(entry.text, width, chalk.dim);
    case 'error':
      return gutter(entry.text, width, chalk.red);
    case 'update': {
      const {text, level} = entry.line;
      if (level === 'output') return wrap(text, width, '      ').map((l) => chalk.dim(l));
      const color = level === 'ok' ? chalk.green : level === 'warn' ? chalk.yellow : level === 'error' ? chalk.red : chalk.dim;
      return gutter(level === 'info' ? `$ ${text}` : text, width, color);
    }
    case 'usage':
      return usageLines(entry, width);
    case 'context':
      return contextLines(entry);
  }
}

/** A subagent's conversation as history lines (its view in the main pane). */
export function agentLines(a: Subagent, width: number): string[] {
  const out: string[] = [
    chalk.magenta.bold(`◆ Subagent #${a.id} ${a.name}`) + chalk.dim(` · ${a.modelLabel ?? a.requested} · ${a.mode} · ${subagentStatusText(a)}`),
    ...wrap(chalk.dim('Task: ') + a.task, width, '  ', '  '),
  ];
  for (const e of a.events) {
    if (e.kind === 'text') out.push(...assistantLines(e.text, width));
    else if (e.kind === 'user') out.push('', ...e.text.split('\n').flatMap((p, i) => wrap(p, width, i === 0 ? chalk.gray('> ') : '  ', '  ')));
    else if (e.kind === 'tool') {
      const dot = e.ok === undefined ? chalk.yellow('⏺ ') : e.ok ? chalk.green('⏺ ') : chalk.red('⏺ ');
      out.push('', ...wrap(chalk.bold(e.label) + chalk.dim(`(${e.summary})`) + diffStatText(e.diff), width, dot, '  '));
      if (e.result !== undefined) out.push(...gutter(toolResultSummary(e.label, e.result), width, e.ok ? chalk.dim : chalk.red).slice(0, 1));
      out.push(...diffLines(e.diff, width, e.summary));
    } else if (e.kind === 'check') out.push(...gutter(`completion check: ${e.note}${e.complete ? '' : ' → continuing'}`, width, e.complete ? chalk.green : chalk.yellow));
    else out.push(...gutter(e.text, width, chalk.dim));
  }
  return out;
}

// Claude Code's dark-theme diff colors: line bars, plus brighter bars on the changed words.
const DIFF = {
  add: chalk.bgRgb(34, 92, 43),
  del: chalk.bgRgb(122, 41, 54),
  addWord: chalk.bgRgb(56, 166, 96),
  delWord: chalk.bgRgb(179, 89, 107),
};

/** Changed character ranges for a removed/added line pair (word-level), or undefined if mostly rewritten. */
function wordRanges(before: string, after: string): {del: Array<[number, number]>; add: Array<[number, number]>} | undefined {
  const parts = diffWordsWithSpace(before, after);
  const del: Array<[number, number]> = [];
  const add: Array<[number, number]> = [];
  let o = 0;
  let n = 0;
  let same = 0;
  for (const p of parts) {
    const len = [...p.value].length;
    if (p.removed) del.push([o, (o += len)]);
    else if (p.added) add.push([n, (n += len)]);
    else {
      o += len;
      n += len;
      same += len;
    }
  }
  // Highlighting words only helps when most of the line is unchanged.
  return same >= Math.max(o, n) * 0.4 ? {del, add} : undefined;
}

/** Re-apply a bright background on character ranges of an already-styled line. */
function emphasize(styled: string, ranges: Array<[number, number]>, bg: (s: string) => string): string {
  if (!ranges.length) return styled;
  let out = '';
  let at = 0;
  for (const [a, b] of ranges) {
    out += sliceAnsi(styled, at, a) + bg(sliceAnsi(styled, a, b));
    at = b;
  }
  return out + sliceAnsi(styled, at);
}

/**
 * Claude-Code-style diff under an edit/write: line-number gutter, syntax-highlighted code (language
 * from the file name in `file`), removed lines on a red bar and added lines on a green bar with the
 * changed words brighter, context dimmed. Lines are clipped to the pane.
 */
export function diffLines(diff: DiffLine[] | undefined, width: number, file?: string): string[] {
  if (!diff?.length) return [];
  const gutterW = Math.max(3, String(Math.max(0, ...diff.map((d) => d.n ?? 0))).length);
  const inner = Math.max(10, width - 4);
  const lang = file?.split(/\s/)[0];
  // Pair each run of removed lines with the following run of added lines (same length) for word emphasis.
  const words = new Map<number, Array<[number, number]>>();
  for (let i = 0; i < diff.length; ) {
    if (diff[i]!.kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < diff.length && diff[d]!.kind === 'del') d++;
    let a = d;
    while (a < diff.length && diff[a]!.kind === 'add') a++;
    if (a - d === d - i) {
      for (let k = 0; k < d - i; k++) {
        const r = wordRanges(diff[i + k]!.text.replace(/\t/g, '  '), diff[d + k]!.text.replace(/\t/g, '  '));
        if (r) {
          words.set(i + k, r.del);
          words.set(d + k, r.add);
        }
      }
    }
    i = a;
  }
  return diff.map((d, idx) => {
    if (d.kind === 'gap' || d.kind === 'note') return chalk.dim(`    ${' '.repeat(gutterW)} ${d.text}`);
    const num = d.n === undefined ? ' '.repeat(gutterW) : String(d.n).padStart(gutterW);
    const sign = d.kind === 'add' ? '+' : d.kind === 'del' ? '-' : ' ';
    const prefix = `${num} ${sign} `;
    const code = d.text.replace(/\t/g, '  ');
    let styled = highlight(code, lang);
    const emph = words.get(idx);
    if (emph) styled = emphasize(styled, emph, d.kind === 'add' ? DIFF.addWord : DIFF.delWord);
    const room = inner - prefix.length;
    if (stringWidth(styled) > room) styled = cliTruncate(styled, Math.max(1, room));
    const fill = ' '.repeat(Math.max(0, room - stringWidth(styled)));
    if (d.kind === 'add') return '    ' + DIFF.add(chalk.green(prefix) + styled + fill);
    if (d.kind === 'del') return '    ' + DIFF.del(chalk.red(prefix) + styled + fill);
    return '    ' + chalk.dim(prefix) + chalk.dim(styled) + fill;
  });
}

function diffStatText(diff: DiffLine[] | undefined): string {
  if (!diff?.length) return '';
  const {added, removed} = diffStats(diff);
  return ` ${chalk.green(`+${added}`)} ${chalk.red(`−${removed}`)}`;
}

/** An assistant message as markdown (headings, lists, code with syntax colors, tables…). */
export function assistantLines(text: string, width: number, first = true): string[] {
  const out = renderMarkdown(text.replace(/\s+$/, ''), width - 2).map((l, i) => (i === 0 && first ? '⏺ ' : '  ') + l);
  return first ? ['', ...out] : out;
}

function usageLines(entry: Extract<Entry, {kind: 'usage'}>, width: number): string[] {
  const BAR = Math.max(8, Math.min(20, width - 50));
  const out: string[] = [''];
  if (!entry.rows.length) out.push(chalk.dim('  No accounts. Use /login.'));
  for (const {account, snapshot, cooldownUntil, error} of entry.rows) {
    out.push(
      `  ${chalk.bold(PROVIDERS[account.provider].name)} ${accountLabel(account)}` +
        (account.plan ? chalk.dim(` · ${account.plan}`) : '') +
        (cooldownUntil ? chalk.red(` · limited until ${clock(cooldownUntil)}`) : ''),
    );
    if (snapshot?.windows.length) {
      for (const w of snapshot.windows) {
        const n = Math.max(0, Math.min(BAR, Math.round((w.usedPct / 100) * BAR)));
        const color = w.usedPct >= 90 ? chalk.red : w.usedPct >= 70 ? chalk.yellow : chalk.green;
        out.push(
          `    ${windowLabel(w.windowMins).padEnd(7)}${color('█'.repeat(n))}${chalk.dim('░'.repeat(BAR - n))} ${`${Math.round(w.usedPct)}%`.padStart(4)}` +
            (w.resetsAt ? chalk.dim(`  resets ${clock(w.resetsAt)} (${relative(w.resetsAt)})`) : ''),
        );
      }
    } else {
      out.push(chalk.dim(`    no usage data yet${account.provider === 'claude' ? ' (appears after the first request)' : ''}`));
    }
    if (snapshot) out.push(chalk.dim(`    updated ${age(snapshot.at)}`));
    if (error) out.push(chalk.red(`    ${error.slice(0, 120)}`));
    out.push('');
  }
  out.push(chalk.dim(`  Jev: ${entry.jev ? 'API key set' : 'no API key (add one in /login)'} · /usage refresh re-checks Claude`));
  return out;
}

const CTX_COLOR = {system: chalk.gray, tools: chalk.yellow, summary: chalk.magenta, messages: chalk.cyan, calls: chalk.green, other: chalk.blue};

function contextLines(entry: Extract<Entry, {kind: 'context'}>): string[] {
  const {report} = entry;
  const {window, categories} = report;
  const COLS = 20;
  const ROWS = 8;
  const cells: string[] = [];
  for (const c of categories) {
    const n = c.tokens ? Math.max(1, Math.round((c.tokens / window) * COLS * ROWS)) : 0;
    for (let i = 0; i < n && cells.length < COLS * ROWS; i++) cells.push(CTX_COLOR[c.key]('⛁'));
  }
  while (cells.length < COLS * ROWS) cells.push(chalk.dim('⛶'));
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  const pct = (n: number) => `${((n / window) * 100).toFixed(1)}%`;
  const used = report.measured ?? report.used;
  const legend = [
    chalk.bold(`${report.modelLabel} · ${k(used)}/${k(window)} tokens (${pct(used)}, ${report.measured !== undefined ? 'measured' : 'est.'})`),
    ...categories.map((c) => `${CTX_COLOR[c.key]('⛁')} ${c.label}: ${chalk.bold(k(c.tokens))}${chalk.dim(` (${pct(c.tokens)})`)}`),
    `${chalk.dim('⛶')} Free space: ${k(Math.max(0, window - report.used))}${chalk.dim(` (${pct(Math.max(0, window - report.used))})`)}`,
  ];
  const rows = Array.from({length: ROWS}, (_, r) => `  ${cells.slice(r * COLS, (r + 1) * COLS).join(' ')}   ${legend[r] ?? ''}`);
  return [
    '',
    ...rows,
    chalk.dim(
      `  ${report.messageCount} messages` +
        (report.summarizedCount ? ` · ${report.summarizedCount} folded into the summary` : '') +
        (report.autoCompactAt ? ` · auto-compacts at ${k(report.autoCompactAt)}` : ' · auto-compact off'),
    ),
  ];
}
