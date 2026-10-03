import {describe, expect, it} from 'vitest';
import {rainbow} from '../src/ui/Working.js';

describe('working indicator', () => {
  it('keeps valid rainbow colors however long a step runs', () => {
    for (const tick of [0, 179, 180, 181, 1500, 100_000])
      for (let i = 0; i < 40; i++) expect(rainbow(i, tick), `tick ${tick} char ${i}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(rainbow(3, 18)).toBe(rainbow(3, 18 + 18 * 100)); // same hue every 360°
  });
});
