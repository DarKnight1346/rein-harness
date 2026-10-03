import {mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {Attachments, droppedPaths, TRAILING_TOKEN_RE} from '../src/ui/attachments.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-att-'));
const png = path.join(dir, 'my shot.png');
writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
const notes = path.join(dir, 'notes.md');
writeFileSync(notes, '# hello\nworld\n');

describe('attachments', () => {
  it('recognizes dropped paths: escaped, quoted, several', () => {
    expect(droppedPaths(png.replace(/ /g, '\\ '))).toEqual([png]);
    expect(droppedPaths(`'${png}' ${notes}`)).toEqual([png, notes]);
    expect(droppedPaths(`"${png}"`)).toEqual([png]);
    expect(droppedPaths('/no/such/file.png')).toBeUndefined();
    expect(droppedPaths('just some text')).toBeUndefined();
  });

  it('big pastes become placeholders and expand on send', async () => {
    const a = new Attachments(() => path.join(dir, 'images'));
    expect(await a.paste('short paste')).toBe('short paste');
    const token = await a.paste('l1\nl2\nl3\nl4\nl5');
    expect(token).toBe('[Pasted text #1 +5 lines]');
    expect(TRAILING_TOKEN_RE.test(`look: ${token}`)).toBe(true);
    expect(a.expand(`look: ${token} ok`)).toEqual({text: 'look: l1\nl2\nl3\nl4\nl5 ok', images: []});
  });

  it('dropped images and files', async () => {
    const a = new Attachments(() => path.join(dir, 'images'));
    const tokens = await a.paste(`${png.replace(/ /g, '\\ ')} ${notes}`);
    expect(tokens).toBe('[Image #1] [File #2: notes.md] ');
    const out = a.expand(`what is this? ${tokens}`);
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.mime).toBe('image/png');
    expect(out.images[0]!.path).toContain(path.join(dir, 'images'));
    expect(out.text).toContain(`<file path="${notes}">\n# hello\nworld\n\n</file>`);
    expect(out.text).toContain('[Image #1]');
  });

  it('clipboard image via fixture', async () => {
    process.env.REIN_CLIPBOARD_IMAGE = png;
    const a = new Attachments(() => path.join(dir, 'images'));
    expect(await a.pasteClipboardImage()).toBe('[Image #1]');
    delete process.env.REIN_CLIPBOARD_IMAGE;
  });
});
