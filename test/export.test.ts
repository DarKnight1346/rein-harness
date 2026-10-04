import {mkdtempSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {conversationMarkdown, writeExport} from '../src/session/export.js';
import {newTranscript} from '../src/session/transcript.js';

describe('/export', () => {
  it('renders every message, skill prompts as typed, tool calls as a list', () => {
    const t = newTranscript();
    t.messages.push(
      {role: 'user', text: '<skill name="plan" source="builtin" dir="/x">…</skill>\n\nadd dark mode', at: 1},
      {role: 'assistant', text: 'Plan ready.', at: 2, model: {provider: 'claude', model: 'opus'}, tools: [{label: 'Read', summary: 'src/app.ts', ok: true, result: '...'}]},
      {role: 'user', text: '<context_compacted>…</context_compacted>', at: 3, synthetic: true},
      {role: 'assistant', text: 'Done.', at: 4, interrupted: true, cutOff: true},
    );
    const md = conversationMarkdown(t);
    expect(md).toContain('# /plan add dark mode');
    expect(md).toContain('## You\n\n/plan add dark mode');
    expect(md).toContain('## Rein · opus\n\n- `Read(src/app.ts)` ✓\n\nPlan ready.');
    expect(md).toContain('compacted here and the agent carried on');
    expect(md).toContain('Rein stopped in the middle of this turn');
  });

  it('writes to the given file, or ~/.rein/exports/<id>.md', () => {
    process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-exp-'));
    const t = newTranscript();
    const def = writeExport(t, '# hi\n');
    expect(def).toBe(path.join(process.env.REIN_HOME, 'exports', `${t.id}.md`));
    const custom = writeExport(t, '# hi\n', path.join(process.env.REIN_HOME, 'notes/chat'));
    expect(custom.endsWith('notes/chat.md')).toBe(true);
    expect(readFileSync(custom, 'utf8')).toBe('# hi\n');
  });
});
