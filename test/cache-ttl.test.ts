import {afterEach, describe, expect, it} from 'vitest';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdtempSync, readFileSync, writeFileSync, chmodSync} from 'node:fs';
import os from 'node:os';
import {claudeOneShot, setPromptCacheTtl} from '../src/providers/claude/session.js';

const original = process.env.REIN_CLAUDE_BIN;
afterEach(() => {
  setPromptCacheTtl(() => undefined);
  if (original === undefined) delete process.env.REIN_CLAUDE_BIN;
  else process.env.REIN_CLAUDE_BIN = original;
});

/** A fake claude that records its CLAUDE_CODE_PROMPT_CACHE_TTL, then answers like fake-claude-stream. */
function fakeRecordingTtl(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rein-ttl-'));
  const out = path.join(dir, 'ttl.txt');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bin = path.join(dir, 'claude.mjs');
  writeFileSync(bin, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? 'unset');\nawait import(${JSON.stringify(path.join(here, 'fixtures', 'fake-claude-stream.mjs'))});\n`);
  chmodSync(bin, 0o755);
  process.env.REIN_CLAUDE_BIN = bin;
  return out;
}

const call = () => claudeOneShot({account: {id: 'claude-1', provider: 'claude', home: null, imported: true}, model: 'haiku', system: 's', prompt: 'p', timeoutMs: 10_000});

describe('cache-5m', () => {
  it('starts claude with a 5-minute prompt cache when set, and leaves the CLI default otherwise', async () => {
    const out = fakeRecordingTtl();
    await call();
    expect(readFileSync(out, 'utf8')).toBe('unset');
    setPromptCacheTtl(() => '5m');
    await call();
    expect(readFileSync(out, 'utf8')).toBe('5m');
  });
});
