import {describe, expect, it} from 'vitest';
import {rainbow} from '../src/ui/Working.js';

describe('working indicator', () => {
  it('keeps valid rainbow colors however long a step runs', () => {
    for (const tick of [0, 179, 180, 181, 1500, 100_000])
      for (let i = 0; i < 40; i++) expect(rainbow(i, tick), `tick ${tick} char ${i}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(rainbow(3, 18)).toBe(rainbow(3, 18 + 18 * 100)); // same hue every 360°
  });
});

describe('elapsed time', async () => {
  const {elapsedText} = await import('../src/ui/Working.js');
  it('ticks up through minutes, hours and days', () => {
    expect(elapsedText(59_000)).toBe('59s');
    expect(elapsedText(125_000)).toBe('2m 05s');
    expect(elapsedText(1279_000)).toBe('21m 19s');
    expect(elapsedText(3_840_000)).toBe('1h 04m');
    expect(elapsedText((2 * 24 + 3) * 3_600_000)).toBe('2d 3h');
  });
});
