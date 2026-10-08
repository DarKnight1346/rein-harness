import {describe, expect, it} from 'vitest';
import {setSelfTest, systemPrompt} from '../src/session/prompt.js';

describe('self-test', () => {
  it('asks the model to run the tests itself when listed', async () => {
    expect(await systemPrompt({tools: true})).not.toMatch(/run the project's tests/);
    setSelfTest(() => true);
    expect(await systemPrompt({tools: true})).toMatch(/run the project's tests \(or build\) yourself/);
    setSelfTest(() => false);
  });

  it('is always on for Codex models, whose own instructions Rein replaces', async () => {
    expect(await systemPrompt({tools: true, provider: 'codex'})).toMatch(/run the project's tests/);
    expect(await systemPrompt({tools: true, provider: 'claude'})).not.toMatch(/run the project's tests/);
  });
});
