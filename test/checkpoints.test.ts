import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {Checkpoints} from '../src/session/checkpoints.js';
import {loadTranscript, newTranscript, saveTranscript, truncateTranscript} from '../src/session/transcript.js';
import {ToolHost} from '../src/tools/host.js';

let root: string;
let sessionId: string;
beforeEach(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-home-'));
  process.env.REIN_CLAUDE_SETTINGS = path.join(process.env.REIN_HOME, 'none.json');
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-proj-')));
  sessionId = `s${Math.random().toString(36).slice(2)}`;
});

describe('checkpoints', () => {
  it('rewinding to a turn restores edited files, re-creates deleted ones and removes new ones', async () => {
    const cp = new Checkpoints(() => sessionId);
    let turn = 0;
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once', checkpoint: (f) => cp.snapshot(turn, f)});
    writeFileSync(path.join(root, 'a.ts'), 'original a\n');
    writeFileSync(path.join(root, 'gone.ts'), 'will be deleted\n');
    turn = 2; // the user's 2nd message: the agent edits, creates and deletes
    await host.call('edit', {path: 'a.ts', old_string: 'original', new_string: 'changed'});
    await host.call('write', {path: 'new.ts', content: 'brand new\n'});
    await host.call('delete', {path: 'gone.ts'});
    turn = 4; // a later message edits a.ts again
    await host.call('edit', {path: 'a.ts', old_string: 'changed', new_string: 'changed twice'});
    expect(cp.changedSince(4)).toEqual([path.join(root, 'a.ts')]);
    expect(cp.changedSince(2).length).toBe(3);

    const r = cp.restore(2);
    expect(readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe('original a\n');
    expect(readFileSync(path.join(root, 'gone.ts'), 'utf8')).toBe('will be deleted\n');
    expect(existsSync(path.join(root, 'new.ts'))).toBe(false);
    expect(r.removed).toEqual([path.join(root, 'new.ts')]);
    expect(cp.changedSince(0)).toEqual([]);
    host.close();
  });

  it('rewinding only to the later turn keeps the earlier changes', async () => {
    const cp = new Checkpoints(() => sessionId);
    const f = path.join(root, 'x.txt');
    writeFileSync(f, 'v0');
    await cp.snapshot(1, f);
    writeFileSync(f, 'v1');
    await cp.snapshot(3, f);
    writeFileSync(f, 'v2');
    cp.restore(3);
    expect(readFileSync(f, 'utf8')).toBe('v1');
  });

  it('snapshots each file of a deleted directory', async () => {
    const cp = new Checkpoints(() => sessionId);
    mkdirSync(path.join(root, 'dir/sub'), {recursive: true});
    writeFileSync(path.join(root, 'dir/a'), 'A');
    writeFileSync(path.join(root, 'dir/sub/b'), 'B');
    await cp.snapshot(1, path.join(root, 'dir'));
    const {rmSync} = await import('node:fs');
    rmSync(path.join(root, 'dir'), {recursive: true});
    cp.restore(1);
    expect(readFileSync(path.join(root, 'dir/sub/b'), 'utf8')).toBe('B');
  });
});

describe('conversation rewind', () => {
  it('truncation survives a reload, and new messages continue from there', async () => {
    const t = newTranscript();
    for (const text of ['one', 'reply one', 'two', 'reply two']) t.messages.push({role: text.startsWith('reply') ? 'assistant' : 'user', text, at: Date.now()});
    await saveTranscript(t);
    await truncateTranscript(t, 2);
    t.messages.push({role: 'user', text: 'two, edited', at: Date.now()});
    await saveTranscript(t);
    const back = await loadTranscript(t.id);
    expect(back!.messages.map((m) => m.text)).toEqual(['one', 'reply one', 'two, edited']);
  });
});
