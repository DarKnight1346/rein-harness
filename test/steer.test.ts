import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {steer, words} from '../src/tools/steer.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'rein-steer-'));
mkdirSync(path.join(root, 'src'));
writeFileSync(path.join(root, 'a.txt'), Array.from({length: 30}, (_, i) => `line ${i + 1}`).join('\n') + '\n');
writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');

describe('shell commands run as built-in tools', () => {
  it('translates the simple read/search forms', () => {
    expect(steer('cat a.txt', root)).toEqual({tool: 'read', args: {path: 'a.txt'}});
    expect(steer('head -n 5 a.txt', root)).toEqual({tool: 'read', args: {path: 'a.txt', limit: 5}});
    expect(steer('head -20 a.txt', root)).toEqual({tool: 'read', args: {path: 'a.txt', limit: 20}});
    expect(steer('tail -n 3 a.txt', root)).toEqual({tool: 'read', args: {path: 'a.txt', offset: 28, limit: 3}});
    expect(steer("sed -n '10,12p' a.txt", root)).toEqual({tool: 'read', args: {path: 'a.txt', offset: 10, limit: 3}});
    expect(steer('ls -la src', root)).toEqual({tool: 'list', args: {path: 'src', all: true}});
    expect(steer('ls', root)).toEqual({tool: 'list', args: {}});
    expect(steer('grep -rn "export const" src', root)).toEqual({tool: 'search', args: {pattern: 'export const', path: 'src'}});
    expect(steer('grep -rniF a.b .', root)).toEqual({tool: 'search', args: {pattern: 'a\\.b', case_insensitive: true}});
    expect(steer('rg TODO', root)).toEqual({tool: 'search', args: {pattern: 'TODO'}});
    expect(steer("find . -name '*.ts' -type f", root)).toEqual({tool: 'search', args: {pattern: '.', files_only: true, glob: '**/*.ts'}});
  });
  it('leaves everything else to the shell', () => {
    for (const c of [
      'cat a.txt | wc -l', // pipe
      'cat a.txt src/b.ts', // two files
      'cat missing.txt', // not a file
      'cat > a.txt', // redirect
      'grep x a.txt && echo y', // chaining
      'grep -c x a.txt', // flag the tool doesn't do
      'grep -l x -r src', // files containing (not the same as files_only)
      'grep x', // reads stdin
      'grep x src', // a directory without -r
      'cat $FILE', // expansion
      'ls *.ts', // shell glob
      "sed -i 's/a/b/' a.txt", // an edit
      'find . -name x -exec rm {} ;',
      'echo "$(cat a.txt)"',
      'npm test',
    ]) expect(steer(c, root), c).toBeUndefined();
    expect(words(`grep "a b" 'c'`)).toEqual(['grep', 'a b', 'c']);
  });
  it('through the tool host: same answer, no approval, and it counts as a read for edit', async () => {
    const {ToolHost} = await import('../src/tools/host.js');
    const asked: string[] = [];
    const host = new ToolHost({root, mode: () => 'ask', approve: async (r) => (asked.push(r.tool.name), 'once')});
    const r = await host.call('shell', {command: 'cat src/b.ts'});
    expect(r.text).toContain('export const b = 1;');
    expect(r.text).toContain('Rein ran `cat` as the read tool');
    expect(asked).toEqual([]); // reads never ask
    const e = await host.call('edit', {path: 'src/b.ts', old_string: 'b = 1', new_string: 'b = 2'});
    expect(e.ok).toBe(true); // no "read it first"
    expect(asked).toEqual(['edit']);
    expect((await host.call('shell', {command: 'cat a.txt'})).text).not.toContain('Rein ran'); // told once
    host.close();
  });
});
