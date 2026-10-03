import os from 'node:os';
import {describe, expect, it} from 'vitest';
import {webTools} from '../src/tools/web.js';
import {DEFAULT_CONFIG} from '../src/store/config.js';
import {redact} from '../src/ui/privacy.js';

describe('web_fetch guards', () => {
  const fetchTool = webTools(() => DEFAULT_CONFIG)[1]!;
  const ctx = {root: '/'} as any;
  for (const url of ['http://localhost:3000', 'https://127.0.0.1/x', 'https://192.168.1.4', 'https://[::1]/', 'https://intranet/', 'https://10.0.0.8/a']) {
    it(`refuses ${url}`, async () => {
      await expect(fetchTool.run(ctx, {url})).rejects.toThrow(/local\/private host/);
    });
  }
  it('rejects non-http and bad URLs', async () => {
    await expect(fetchTool.run(ctx, {url: 'file:///etc/passwd'})).rejects.toThrow(/only http/);
    await expect(fetchTool.run(ctx, {url: 'not a url'})).rejects.toThrow(/not a valid URL/);
  });
});

describe('privacy', () => {
  it('redacts the home folder and username by default', () => {
    expect(redact(`${os.homedir()}/Desktop/proj/a.ts`)).toBe('~/Desktop/proj/a.ts');
  });
});
