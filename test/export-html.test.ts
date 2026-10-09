import {describe, expect, it} from 'vitest';
import {conversationHtml} from '../src/session/export.js';
import {newTranscript} from '../src/session/transcript.js';

describe('/export html', () => {
  it('is one page with the messages, tool calls and diffs, and never runs HTML from the conversation', () => {
    const t = newTranscript();
    t.messages.push(
      {role: 'user', text: 'Fix the **limit** <script>alert(1)</script>', at: 1},
      {role: 'assistant', text: 'Done: the window resets now.', at: 2, model: {provider: 'claude', model: 'opus'}, tools: [{label: 'Edit', summary: 'src/limit.ts', ok: true, result: 'ok', diff: [{kind: 'del', n: 12, text: 'if (n > max)'}, {kind: 'add', n: 12, text: 'if (n >= max)'}]}]},
    );
    const html = conversationHtml(t);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<strong>limit</strong>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<div class="del"><span class="n">12</span>- if (n &gt; max)</div>');
    expect(html).toContain('<div class="who">Rein · opus</div>');
  });
});
