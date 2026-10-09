import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Marked} from 'marked';
import {reinHome} from '../store/paths.js';
import type {Transcript} from './transcript.js';

/** A stored user message as typed (skill prompts back to `/name args`). */
const typed = (text: string) => text.replace(/^<skill name="([^"]+)"[\s\S]*?<\/skill>\s*/, '/$1 ').replace(/\n\n<hook_context>[\s\S]*<\/hook_context>$/, '').trim();

/**
 * `/export`: the whole conversation as Markdown, every message (compaction never deletes any),
 * with each reply's tool calls as a compact list. Results and diffs are left out: they're long and
 * live in the session log.
 */
export function conversationMarkdown(t: Transcript, opts: {redact?: (s: string) => string} = {}): string {
  const r = opts.redact ?? ((s: string) => s);
  const first = t.messages.find((m) => m.role === 'user' && !m.synthetic);
  const title = first ? typed(first.text).split('\n')[0]!.slice(0, 80) : 'Conversation';
  const models = [...new Set(t.messages.flatMap((m) => (m.model ? [m.model.model] : [])))];
  const out = [
    `# ${title}`,
    '',
    `*Rein conversation \`${t.id}\` · ${new Date(t.createdAt || Date.now()).toLocaleString()}${t.cwd ? ` · ${r(t.cwd)}` : ''}${models.length ? ` · ${models.join(', ')}` : ''}*`,
    '',
  ];
  for (const m of t.messages) {
    if (m.synthetic) {
      out.push('> *The conversation was compacted here and the agent carried on.*', '');
      continue;
    }
    if (m.role === 'user') {
      out.push('## You', '', r(typed(m.text)), '');
      continue;
    }
    out.push(`## Rein${m.model ? ` · ${m.model.model}` : ''}`, '');
    if (m.tools?.length) out.push(...m.tools.map((c) => `- \`${c.label}(${r(c.summary).replace(/`/g, "'")})\` ${c.ok ? '✓' : '✗'}`), '');
    if (m.text.trim()) out.push(r(m.text.trim()), '');
    if (m.cutOff) out.push('> *Rein stopped in the middle of this turn; the work above was saved.*', '');
    else if (m.interrupted) out.push('> *Interrupted.*', '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Where `/export` writes: the given path (relative to the project), else ~/.rein/exports/<id>.md. */
export function writeExport(t: Transcript, markdown: string, target?: string, ext: 'md' | 'html' = 'md'): string {
  const file = target ? path.resolve(process.cwd(), target.endsWith(`.${ext}`) ? target : `${target}.${ext}`) : path.join(reinHome(), 'exports', `${t.id}.${ext}`);
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, markdown, {mode: 0o600});
  return file;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markdown to HTML for a page others will open: raw HTML in the text is shown, never run. */
const html = new Marked({renderer: {html: ({text}) => esc(text)}, gfm: true});
const md = (s: string) => html.parse(s, {async: false}) as string;

const STYLE = `body{margin:0;background:#0b0d10;color:#e6e9ef;font:15px/1.6 system-ui,-apple-system,sans-serif}main{max-width:880px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px}.meta{color:#8a909c;font-size:13px;margin-bottom:28px}
section{border-top:1px solid #20242b;padding:18px 0}.who{font:600 12px ui-monospace,Menlo,monospace;color:#7cf5c4;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em}.you .who{color:#7aa7ff}
.tool{font:13px ui-monospace,Menlo,monospace;color:#b8bec9;margin:4px 0}.tool .ok{color:#5ef2a0}.tool .bad{color:#ff6b81}
pre{background:#111419;border:1px solid #20242b;border-radius:8px;padding:10px 12px;overflow:auto;font:12.5px/1.5 ui-monospace,Menlo,monospace}code{font-family:ui-monospace,Menlo,monospace}
.diff div{white-space:pre}.add{background:#163c1e}.del{background:#4e1a22}.gap,.note{color:#6c7280}.n{display:inline-block;width:4ch;color:#6c7280}.notice{color:#8a909c;font-style:italic}`;

/** /export html: the conversation as one self-contained page, with tool calls and their diffs, to share. */
export function conversationHtml(t: Transcript, opts: {redact?: (s: string) => string} = {}): string {
  const r = opts.redact ?? ((s: string) => s);
  const first = t.messages.find((m) => m.role === 'user' && !m.synthetic);
  const title = first ? typed(first.text).split('\n')[0]!.slice(0, 80) : 'Conversation';
  const models = [...new Set(t.messages.flatMap((m) => (m.model ? [m.model.model] : [])))];
  const parts: string[] = [];
  for (const m of t.messages) {
    if (m.synthetic) {
      parts.push('<p class="notice">The conversation was compacted here and the agent carried on.</p>');
      continue;
    }
    if (m.role === 'user') {
      parts.push(`<section class="you"><div class="who">You</div>${md(r(typed(m.text)))}</section>`);
      continue;
    }
    const tools = (m.tools ?? []).map((c) => {
      const diff = c.diff?.length ? `<pre class="diff">${c.diff.map((d) => `<div class="${d.kind}">${d.n !== undefined ? `<span class="n">${d.n}</span>` : ''}${d.kind === 'add' ? '+ ' : d.kind === 'del' ? '- ' : '  '}${esc(r(d.text))}</div>`).join('')}</pre>` : '';
      return `<div class="tool"><span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span> ${esc(c.label)}(${esc(r(c.summary))})</div>${diff}`;
    });
    parts.push(`<section><div class="who">Rein${m.model ? ` · ${esc(m.model.model)}` : ''}</div>${tools.join('')}${m.text.trim() ? md(r(m.text.trim())) : ''}${m.cutOff ? '<p class="notice">Rein stopped in the middle of this turn; the work above was saved.</p>' : m.interrupted ? '<p class="notice">Interrupted.</p>' : ''}</section>`);
  }
  const meta = `Rein conversation ${esc(t.id)} · ${esc(new Date(t.createdAt || Date.now()).toLocaleString())}${t.cwd ? ` · ${esc(r(t.cwd))}` : ''}${models.length ? ` · ${esc(models.join(', '))}` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><h1>${esc(title)}</h1><div class="meta">${meta}</div>${parts.join('\n')}</main></body></html>\n`;
}
