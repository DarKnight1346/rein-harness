import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {claudeOneShot} from '../src/providers/claude/session.js';
import type {ModelRef, TokenCount} from '../src/providers/types.js';
import {onSideUsage} from '../src/providers/usage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const original = process.env.REIN_CLAUDE_BIN;
afterEach(() => {
  if (original === undefined) delete process.env.REIN_CLAUDE_BIN;
  else process.env.REIN_CLAUDE_BIN = original;
});

describe('one-off model calls', () => {
  it('report what they used, so helpers (advisor, compaction, decisions) are never free on paper', async () => {
    process.env.REIN_CLAUDE_BIN = path.join(here, 'fixtures', 'fake-claude-stream.mjs');
    const seen: [ModelRef, TokenCount][] = [];
    const stop = onSideUsage((ref, t) => seen.push([ref, t]));
    const reply = await claudeOneShot({account: {id: 'claude-1', provider: 'claude', home: null, imported: true}, model: 'haiku', system: 's', prompt: 'p', timeoutMs: 10_000});
    stop();
    expect(reply).toBe('ok');
    // Both API calls of the one-shot, input including cache reads.
    expect(seen).toEqual([[{provider: 'claude', model: 'haiku'}, {input: 10_200, cached: 9_000, output: 80}]]);
  });
});
