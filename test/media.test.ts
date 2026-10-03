import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {readTool} from '../src/tools/fs.js';

const ctx = {root: path.resolve('test/fixtures')} as any;

describe('reading images and PDFs', () => {
  it('an image comes back as an image the model can see', async () => {
    const r = await readTool(ctx, {path: 'green.png'});
    expect(r.text).toMatch(/Image green\.png \(32×32\)/);
    expect(r.images?.[0]?.mime).toBe('image/png');
    expect(Buffer.from(r.images![0]!.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  });

  it('a PDF comes back as text, page by page, with page ranges', async () => {
    const all = await readTool(ctx, {path: 'report.pdf'});
    expect(all.text).toContain('2 pages, showing 1–2');
    expect(all.text).toContain('--- page 1 ---\nQuarterly report: revenue was 4.2 million.');
    expect(all.text).toContain('launch code is ORCHID-7');
    const two = await readTool(ctx, {path: 'report.pdf', pages: '2'});
    expect(two.text).toContain('--- page 2 ---');
    expect(two.text).not.toContain('Quarterly');
    await expect(readTool(ctx, {path: 'report.pdf', pages: '5'})).rejects.toThrow(/has 2 pages/);
  });
});
