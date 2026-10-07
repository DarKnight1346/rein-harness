import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { reinHome } from '../store/paths.js';
/** A stored user message as typed (skill prompts back to `/name args`). */
const typed = (text) => text.replace(/^<skill name="([^"]+)"[\s\S]*?<\/skill>\s*/, '/$1 ').replace(/\n\n<hook_context>[\s\S]*<\/hook_context>$/, '').trim();
/**
 * `/export`: the whole conversation as Markdown, every message (compaction never deletes any),
 * with each reply's tool calls as a compact list. Results and diffs are left out: they're long and
 * live in the session log.
 */
export function conversationMarkdown(t, opts = {}) {
    const r = opts.redact ?? ((s) => s);
    const first = t.messages.find((m) => m.role === 'user' && !m.synthetic);
    const title = first ? typed(first.text).split('\n')[0].slice(0, 80) : 'Conversation';
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
        if (m.tools?.length)
            out.push(...m.tools.map((c) => `- \`${c.label}(${r(c.summary).replace(/`/g, "'")})\` ${c.ok ? '✓' : '✗'}`), '');
        if (m.text.trim())
            out.push(r(m.text.trim()), '');
        if (m.cutOff)
            out.push('> *Rein stopped in the middle of this turn; the work above was saved.*', '');
        else if (m.interrupted)
            out.push('> *Interrupted.*', '');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
/** Where `/export` writes: the given path (relative to the project), else ~/.rein/exports/<id>.md. */
export function writeExport(t, markdown, target) {
    const file = target ? path.resolve(process.cwd(), target.endsWith('.md') ? target : `${target}.md`) : path.join(reinHome(), 'exports', `${t.id}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, markdown, { mode: 0o600 });
    return file;
}
