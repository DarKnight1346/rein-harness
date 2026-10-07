import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { renderMarkdown } from './markdown.js';
/**
 * Plans show rendered wherever the agent writes or presents one (not as a markdown diff): a plan
 * file is a .md file in a `plans/` folder or with "plan" in its name. The text is captured when the
 * tool call finishes, so the entry keeps showing that version.
 */
const PLAN_FILE = /(^|[\\/])plans[\\/][^\\/]+\.md$|plan[^\\/]*\.md$/i;
const MAX_LINES = 40;
export const isPlanFile = (p) => PLAN_FILE.test(p.trim());
const resolve = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : path.resolve(process.cwd(), p));
/** Captured once per tool call (later renders reuse it, so an entry keeps the version it wrote). */
const captured = new Map();
/** For a finished Write/Edit of a plan file, or a presented plan: the plan's markdown. */
export function planPreview(label, summary, ok, result) {
    if (!ok)
        return undefined;
    const key = `${label}\u0000${summary}\u0000${result}`;
    if (captured.has(key))
        return captured.get(key);
    const text = readPreview(label, summary, result);
    if (captured.size > 200)
        captured.delete(captured.keys().next().value);
    captured.set(key, text);
    return text;
}
function readPreview(label, summary, result) {
    let file;
    if ((label === 'Write' || label === 'Edit') && isPlanFile(summary))
        file = summary.trim();
    else if (label === 'Plan')
        file = /saved to (\S+?\.md)\b/.exec(result)?.[1];
    if (!file)
        return undefined;
    try {
        return readFileSync(resolve(file), 'utf8');
    }
    catch {
        return undefined;
    }
}
/** The plan rendered inside a left bar, capped (the rest is in the file). */
export function planPreviewLines(markdown, width) {
    const lines = renderMarkdown(markdown.trim(), Math.max(20, width - 6));
    const shown = lines.slice(0, MAX_LINES);
    const bar = chalk.dim('  ▎ ');
    return [...shown.map((l) => bar + l), ...(lines.length > shown.length ? [chalk.dim(`  ▎ … ${lines.length - shown.length} more lines in the file`)] : [])];
}
