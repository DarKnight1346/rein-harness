import chalk from 'chalk';
import cliTruncate from 'cli-truncate';
import hljs from 'highlight.js';
import { marked } from 'marked';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { BLOCK_MATH, INLINE_MATH, latexToUnicode } from './latex.js';
/**
 * Markdown → styled terminal lines, the way Claude Code does it: `marked` tokenizes, a recursive
 * formatter turns tokens into chalk text, highlight.js colors code. Output is pre-wrapped to
 * `width` so lists/quotes keep hanging indents in the line-based history pane.
 */
// Inline code / accents (Claude Code's "permission" blue-violet).
const ACCENT = chalk.hex('#b1b9f9');
const MATH = chalk.hex('#e5c07b');
// LaTeX math → Unicode (latex.ts): `$x^2$` inline, `$$…$$` as its own block.
marked.use({
    extensions: [
        {
            name: 'math',
            level: 'inline',
            start: (src) => {
                const a = src.indexOf('$');
                const b = src.indexOf('\\(');
                return a < 0 ? (b < 0 ? undefined : b) : b < 0 ? a : Math.min(a, b);
            },
            tokenizer(src) {
                const m = INLINE_MATH.exec(src);
                return m ? { type: 'math', raw: m[0], text: m[1] ?? m[2] ?? '' } : undefined;
            },
        },
        {
            name: 'mathBlock',
            level: 'block',
            start: (src) => {
                const a = src.indexOf('$$');
                const b = src.indexOf('\\[');
                return a < 0 ? (b < 0 ? undefined : b) : b < 0 ? a : Math.min(a, b);
            },
            tokenizer(src) {
                const m = BLOCK_MATH.exec(src);
                return m ? { type: 'mathBlock', raw: m[0], text: (m[1] ?? m[2] ?? '').trim() } : undefined;
            },
        },
    ],
});
// One-Dark-ish palette for highlight.js scopes.
const SCOPES = {
    keyword: chalk.hex('#c678dd'),
    built_in: chalk.hex('#e6c07b'),
    type: chalk.hex('#e6c07b'),
    class: chalk.hex('#e6c07b'),
    literal: chalk.hex('#56b6c2'),
    number: chalk.hex('#d19a66'),
    string: chalk.hex('#98c379'),
    regexp: chalk.hex('#98c379'),
    char: chalk.hex('#98c379'),
    comment: chalk.hex('#7f848e').italic,
    doctag: chalk.hex('#c678dd'),
    quote: chalk.hex('#7f848e').italic,
    title: chalk.hex('#61afef'),
    function: chalk.hex('#61afef'),
    section: chalk.hex('#61afef').bold,
    meta: chalk.hex('#61afef'),
    attr: chalk.hex('#d19a66'),
    attribute: chalk.hex('#d19a66'),
    property: chalk.hex('#e06c75'),
    variable: chalk.hex('#e06c75'),
    'template-variable': chalk.hex('#e06c75'),
    name: chalk.hex('#e06c75'),
    tag: chalk.hex('#e06c75'),
    'selector-tag': chalk.hex('#e06c75'),
    'selector-class': chalk.hex('#d19a66'),
    'selector-id': chalk.hex('#61afef'),
    symbol: chalk.hex('#56b6c2'),
    bullet: chalk.hex('#d19a66'),
    link: chalk.hex('#56b6c2').underline,
    addition: chalk.hex('#98c379'),
    deletion: chalk.hex('#e06c75'),
    emphasis: chalk.italic,
    strong: chalk.bold,
};
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, e) => ENTITIES[e]);
/** highlight.js HTML → ANSI (innermost scope's color wins). */
function htmlToAnsi(html) {
    const stack = [];
    let out = '';
    for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
        if (!part)
            continue;
        if (part.startsWith('<span')) {
            const classes = /class="([^"]*)"/.exec(part)[1].split(' ').map((c) => c.replace(/^hljs-/, '').replace(/_$/, ''));
            stack.push(classes.map((c) => SCOPES[c] ?? SCOPES[c.split('.')[0]]).find(Boolean) ?? stack.at(-1));
        }
        else if (part === '</span>')
            stack.pop();
        else {
            const text = decode(part);
            const color = stack.at(-1);
            out += color ? text.split('\n').map((l) => (l ? color(l) : l)).join('\n') : text;
        }
    }
    return out;
}
/** Language id highlight.js knows for a fence tag or file name/extension (`ts`, `src/a.tsx`, `Makefile`). */
export function languageFor(hint) {
    if (!hint)
        return undefined;
    const base = hint.trim().split(/[\\/]/).pop() ?? '';
    const ext = /\.([A-Za-z0-9+#-]+)$/.exec(base)?.[1];
    for (const c of [hint.trim().match(/^[\w.+#-]+/)?.[0], ext, base])
        if (c && hljs.getLanguage(c))
            return c;
    return undefined;
}
/** Syntax-highlight `code` (lines kept intact); plain text when the language is unknown. */
export function highlight(code, lang) {
    const l = languageFor(lang);
    if (!l)
        return code;
    try {
        return htmlToAnsi(hljs.highlight(code, { language: l, ignoreIllegals: true }).value);
    }
    catch {
        return code;
    }
}
/** Wrap a styled string to `width`, `first`/`rest` prefixes on its lines. */
function wrapTo(text, width, first = '', rest = ' '.repeat(stringWidth(first))) {
    const inner = Math.max(8, width - stringWidth(first));
    return text.split('\n').flatMap((para, pi) => wrapAnsi(para, inner, { hard: true, trim: false })
        .split('\n')
        .map((l, i) => (pi === 0 && i === 0 ? first : rest) + l.replace(/ +$/, '')));
}
function inline(tokens) {
    return (tokens ?? []).map(inlineToken).join('');
}
function inlineToken(t) {
    switch (t.type) {
        case 'strong':
            return chalk.bold(inline(t.tokens));
        case 'em':
            return chalk.italic(inline(t.tokens));
        case 'del':
            return chalk.strikethrough(inline(t.tokens));
        case 'codespan':
            return ACCENT(t.text);
        case 'math':
            return MATH(latexToUnicode(t.text));
        case 'br':
            return '\n';
        case 'link': {
            const l = t;
            const label = inline(l.tokens);
            const plain = l.text;
            if (l.href.startsWith('mailto:'))
                return label;
            return plain && plain !== l.href ? `${chalk.underline(label)} ${chalk.dim(`(${l.href})`)}` : chalk.underline(l.href);
        }
        case 'image': {
            const i = t;
            return chalk.dim(`[image: ${i.text || i.href}]`);
        }
        case 'text': {
            const x = t;
            return x.tokens ? inline(x.tokens) : x.text;
        }
        case 'checkbox':
            return '';
        default:
            return 'text' in t && typeof t.text === 'string' ? t.text : (t.raw ?? '');
    }
}
const BULLETS = ['•', '◦', '▪'];
/** Block tokens → lines (no trailing blank). Blank lines separate blocks unless `tight`. */
function blocks(tokens, width, depth = 0, tight = false) {
    const out = [];
    for (const t of tokens) {
        if (t.type === 'space' || t.type === 'checkbox')
            continue;
        const lines = block(t, width, depth);
        if (!lines.length)
            continue;
        if (out.length && !tight)
            out.push('');
        out.push(...lines);
    }
    return out;
}
function block(t, width, depth) {
    switch (t.type) {
        case 'heading': {
            const h = t;
            const style = h.depth === 1 ? chalk.bold.italic.underline : h.depth === 2 ? chalk.bold : chalk.bold.dim;
            return wrapTo(style(inline(h.tokens)), width);
        }
        case 'paragraph':
            return wrapTo(inline(t.tokens), width);
        case 'text': {
            const x = t;
            return wrapTo(x.tokens ? inline(x.tokens) : x.text, width);
        }
        case 'mathBlock':
            return latexToUnicode(t.text)
                .split('\n')
                .flatMap((l) => wrapTo(MATH(l.trim()), width - 4).map((x) => `    ${x}`));
        case 'code': {
            const c = t;
            const lang = c.lang?.trim();
            const known = languageFor(lang);
            const body = highlight(c.text.replace(/\t/g, '  '), known);
            const label = lang && !known ? [chalk.dim(lang)] : [];
            // Code isn't re-flowed: long lines are clipped to the pane like an editor.
            const inner = Math.max(8, width - 2);
            return [...label, ...body.split('\n').map((l) => '  ' + (stringWidth(l) > inner ? cliTruncate(l, inner) : l))];
        }
        case 'blockquote': {
            const bar = chalk.dim('▎ ');
            return blocks(t.tokens, width - 2, depth).map((l) => (l ? bar + chalk.italic(l) : chalk.dim('▎')));
        }
        case 'list': {
            const list = t;
            const start = typeof list.start === 'number' ? list.start : 1;
            const out = [];
            list.items.forEach((item, i) => {
                const marker = list.ordered ? `${start + i}.` : BULLETS[depth % BULLETS.length];
                const box = item.task ? (item.checked ? chalk.green('[x] ') : '[ ] ') : '';
                const head = `${marker} ${box}`;
                const pad = ' '.repeat(stringWidth(head));
                const body = blocks(item.tokens, width - pad.length, depth + 1, !item.loose);
                if (list.loose && i)
                    out.push('');
                body.forEach((l, j) => out.push(j === 0 ? `${list.ordered ? marker : chalk.dim(marker)} ${box}${l}` : l ? pad + l : l));
                if (!body.length)
                    out.push(head);
            });
            return out;
        }
        case 'table':
            return table(t, width);
        case 'hr':
            return [chalk.dim('─'.repeat(Math.max(3, Math.min(width, 80))))];
        case 'html':
            return wrapTo(t.text.replace(/\n+$/, ''), width);
        default:
            return 'raw' in t && t.raw ? wrapTo(t.raw.replace(/\n+$/, ''), width) : [];
    }
}
function table(t, width) {
    const head = t.header.map((c) => chalk.bold(inline(c.tokens)));
    const rows = t.rows.map((r) => r.map((c) => inline(c.tokens)));
    const widths = head.map((h, i) => Math.max(3, stringWidth(h), ...rows.map((r) => stringWidth(r[i] ?? ''))));
    const cell = (s, i) => {
        const w = widths[i];
        const gap = w - stringWidth(s);
        const align = t.align[i];
        if (align === 'right')
            return ' '.repeat(gap) + s;
        if (align === 'center')
            return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2));
        return s + ' '.repeat(gap);
    };
    const line = (cells) => `│ ${cells.map(cell).join(' │ ')} │`;
    const rule = (l, m, r) => chalk.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
    const lines = [rule('┌', '┬', '┐'), line(head), rule('├', '┼', '┤'), ...rows.map(line), rule('└', '┴', '┘')];
    // Too wide for the pane: clip rather than wrap (wrapping breaks the grid).
    return lines.map((l) => (stringWidth(l) > width ? cliTruncate(l, width) : l));
}
const cache = new Map();
/** Rendered lines for an assistant message (cached by text + width; streaming re-renders the tail). */
export function renderMarkdown(text, width) {
    const key = `${width}\u0000${text}`;
    const hit = cache.get(key);
    if (hit)
        return hit;
    let lines;
    try {
        lines = blocks(marked.lexer(text), Math.max(10, width));
    }
    catch {
        lines = wrapTo(text, width);
    }
    if (cache.size > 500)
        cache.delete(cache.keys().next().value);
    cache.set(key, lines);
    return lines;
}
