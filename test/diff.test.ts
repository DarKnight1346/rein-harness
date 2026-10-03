import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {createdDiff, fileDiff} from '../src/tools/diff.js';
import {ToolHost, type ToolActivity} from '../src/tools/host.js';
import {diffLines} from '../src/ui/fullscreen/lines.js';

describe('diffs', () => {
  it('shows removed/added lines with context and line numbers', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n') + '\n';
    const after = ['a', 'b', 'c', 'D!', 'e', 'f', 'g'].join('\n') + '\n';
    expect(fileDiff(before, after)).toEqual([
      {kind: 'ctx', n: 2, text: 'b'},
      {kind: 'ctx', n: 3, text: 'c'},
      {kind: 'del', n: 4, text: 'd'},
      {kind: 'add', n: 4, text: 'D!'},
      {kind: 'ctx', n: 5, text: 'e'},
      {kind: 'ctx', n: 6, text: 'f'},
    ]);
  });
  it('new files are additions; long diffs are capped', () => {
    expect(createdDiff('x\ny\n')).toEqual([{kind: 'add', n: 1, text: 'x'}, {kind: 'add', n: 2, text: 'y'}]);
    const many = createdDiff(Array.from({length: 100}, (_, i) => `l${i}`).join('\n'));
    expect(many).toHaveLength(41);
    expect(many.at(-1)).toEqual({kind: 'note', text: '… 60 more diff lines'});
  });
  it('the host keeps diffs out of the model result but emits them for the UI', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rein-proj-'));
    await writeFile(path.join(root, 'f.ts'), 'const a = 1;\nconst b = 2;\n');
    const host = new ToolHost({root, mode: () => 'bypass', approve: async () => 'once'});
    const acts: ToolActivity[] = [];
    await host.call('read', {path: 'f.ts'}); // edits need a prior read (stale-file protection)
    host.on('activity', (a) => acts.push(a));
    const res = await host.call('edit', {path: 'f.ts', old_string: 'const b = 2;', new_string: 'const b = 3;'});
    expect(res).toEqual({ok: true, text: 'Edited f.ts: 1 replacement at line 2'});
    const end = acts.find((a) => a.phase === 'end') as any;
    expect(end.diff.map((d: any) => `${d.kind}:${d.text}`)).toEqual(['ctx:const a = 1;', 'del:const b = 2;', 'add:const b = 3;']);
    const stringWidth = (await import('string-width')).default;
    for (const l of diffLines(end.diff, 30)) expect(stringWidth(l)).toBeLessThanOrEqual(30);
  });
});
