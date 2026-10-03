import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {Attachments} from '../src/ui/attachments.js';
import {mentionAt, mentionedPaths, primeFiles, suggestFiles} from '../src/ui/mentions.js';

let root: string;
beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-mention-')));
  mkdirSync(path.join(root, 'src/ui'), {recursive: true});
  writeFileSync(path.join(root, 'src/ui/Button.tsx'), 'export const Button = 1;\n');
  writeFileSync(path.join(root, 'src/server.ts'), 'listen(8080)\n');
  writeFileSync(path.join(root, 'README.md'), '# hi\n');
  writeFileSync(path.join(root, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await primeFiles(root);
});

describe('@file mentions', () => {
  it('finds the mention being typed', () => {
    expect(mentionAt('look at @src/ui/Bu')).toEqual({start: 8, query: 'src/ui/Bu'});
    expect(mentionAt('email me@x.com')).toBeUndefined();
    expect(mentionAt('@')).toEqual({start: 0, query: ''});
  });

  it('ranks files (basename first) and offers folders', () => {
    expect(suggestFiles(root, 'butt')[0]).toBe('src/ui/Button.tsx');
    expect(suggestFiles(root, 'srv')).toContain('src/server.ts'); // fuzzy
    expect(suggestFiles(root, 'src/u')).toContain('src/ui/');
  });

  it('attaches text files, images and folder listings on send', () => {
    const a = new Attachments(() => path.join(root, '.imgs'));
    const out = a.expand('compare @src/server.ts with @logo.png and look in @src/ui/', root);
    expect(out.text).toContain('<file path="src/server.ts">\nlisten(8080)');
    expect(out.images.map((i) => path.basename(i.path))).toEqual(['logo.png']);
    expect(out.text).toContain('<directory path="src/ui">\nButton.tsx');
    expect(mentionedPaths('see @nope.ts', root)).toEqual([]);
  });
});
