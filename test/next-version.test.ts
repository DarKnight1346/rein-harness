import {describe, expect, it} from 'vitest';
// @ts-expect-error plain JS release script
import {nextVersion} from '../scripts/next-version.mjs';

describe('release version', () => {
  it('bumps the patch past npm', () => {
    expect(nextVersion('0.1.0', '0.1.0')).toBe('0.1.1');
    expect(nextVersion('0.1.0', '0.1.7')).toBe('0.1.8');
  });
  it('uses package.json when it is ahead (manual minor/major bump)', () => {
    expect(nextVersion('0.2.0', '0.1.9')).toBe('0.2.0');
    expect(nextVersion('1.0.0', '0.9.3')).toBe('1.0.0');
  });
  it('first publish, and pre-release on npm', () => {
    expect(nextVersion('0.1.0', '')).toBe('0.1.0');
    expect(nextVersion('0.1.0', '0.2.0-beta.1')).toBe('0.2.0');
  });
});
