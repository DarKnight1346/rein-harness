import {describe, expect, it} from 'vitest';
import {PHRASES, pickPhrase} from '../src/ui/phrases.js';

describe('working-line phrases', () => {
  it('has 300 to 400 of them, one to four words each, no repeats', () => {
    expect(PHRASES.length).toBeGreaterThanOrEqual(300);
    expect(PHRASES.length).toBeLessThanOrEqual(400);
    expect(new Set(PHRASES).size).toBe(PHRASES.length);
    for (const p of PHRASES) expect(p.split(/\s+/).length, p).toBeLessThanOrEqual(4);
  });

  it('never picks the same one twice in a row', () => {
    const fixed = () => 0.5; // the same random number every time
    const a = pickPhrase(fixed);
    const b = pickPhrase(fixed);
    expect(b).not.toBe(a);
  });
});
