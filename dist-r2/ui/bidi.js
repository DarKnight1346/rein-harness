import stripAnsi from 'strip-ansi';
/**
 * Right-to-left text (Hebrew, Arabic…) for terminals that don't lay it out themselves. Text is
 * stored and copied in logical order; only the displayed line is reordered into visual order
 * (the Unicode bidi algorithm's levels and L2 reordering, per line, by grapheme so combining
 * marks stay with their letter). Terminals with their own bidi (Terminal.app, GNOME, Konsole,
 * mlterm) are left alone, since reordering there would reverse it twice.
 */
export function needsBidi(env = process.env, setting = 'auto') {
    if (setting !== 'auto')
        return setting === 'on';
    if (env.TERM_PROGRAM === 'Apple_Terminal' || env.VTE_VERSION || env.KONSOLE_VERSION || env.TERM === 'mlterm')
        return false;
    return env.TERM_PROGRAM === 'vscode' || !!env.WT_SESSION || env.TERM === 'xterm-kitty' || env.TERM_PROGRAM === 'ghostty' || env.TERM === 'alacritty' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'iTerm.app';
}
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ฀-๿぀-ヿ一-鿿]/;
const NUM = /[0-9٠-٩۰-۹]/;
export const hasRtl = (s) => RTL.test(s);
const kindOf = (g) => (RTL.test(g) ? 'R' : NUM.test(g) ? 'EN' : LTR.test(g) || /\p{L}/u.test(g) ? 'L' : 'N');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** A line in visual (left-to-right display) order. Lines without RTL text come back unchanged. */
export function visualOrder(line) {
    if (!RTL.test(line))
        return line;
    const plain = stripAnsi(line); // reordering splits styles apart: RTL lines show unstyled
    const indent = /^\s*/.exec(plain)[0];
    const g = [...segmenter.segment(plain.slice(indent.length))].map((s) => s.segment);
    const kinds = g.map(kindOf);
    const firstStrong = kinds.find((k) => k === 'L' || k === 'R');
    const base = firstStrong === 'R' ? 1 : 0;
    // Neutrals take the direction of the strong characters around them when those agree, else the base.
    const strongAt = (i, step) => {
        for (let j = i; j >= 0 && j < kinds.length; j += step)
            if (kinds[j] === 'L' || kinds[j] === 'R')
                return kinds[j];
        return undefined;
    };
    const levels = kinds.map((k, i) => {
        if (k === 'R')
            return 1;
        if (k === 'L')
            return base === 1 ? 2 : 0;
        if (k === 'EN')
            return base === 1 || strongAt(i, -1) === 'R' ? 2 : 0; // numbers read left to right, inside RTL too
        const before = strongAt(i, -1) ?? (base ? 'R' : 'L');
        const after = strongAt(i, 1) ?? (base ? 'R' : 'L');
        return before === after ? (before === 'R' ? 1 : base === 1 ? 2 : 0) : base;
    });
    // L2: from the highest level down to the lowest odd one, reverse every run at that level or higher.
    const order = g.map((_, i) => i);
    const max = Math.max(...levels);
    const lowestOdd = Math.min(...levels.filter((l) => l % 2 === 1).concat([max]));
    for (let lvl = max; lvl >= Math.max(1, lowestOdd); lvl--) {
        for (let i = 0; i < order.length;) {
            if (levels[order[i]] < lvl) {
                i++;
                continue;
            }
            let j = i;
            while (j < order.length && levels[order[j]] >= lvl)
                j++;
            order.splice(i, j - i, ...order.slice(i, j).reverse());
            i = j;
        }
    }
    const mirror = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
    return indent + order.map((i) => (levels[i] % 2 === 1 && mirror[g[i]] ? mirror[g[i]] : g[i])).join('');
}
