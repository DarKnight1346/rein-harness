import {describe, expect, it} from 'vitest';
import {splashState} from '../src/ui/fullscreen/SplashScreen.js';

describe('splash timing', () => {
  it('fades in, drifts for a few seconds, then stops animating', () => {
    const p = {fadeIn: 0};
    expect(splashState(p, 350)).toEqual({opacity: 0.5, animating: true});
    expect(splashState(p, 3000)).toEqual({opacity: 1, animating: true});
    expect(splashState(p, 7000).animating).toBe(false); // holds still: no timer, no redraws
    expect(splashState(p, 7000).opacity).toBe(1);
  });
  it('fades out after the first message and is gone for good', () => {
    const p = {fadeIn: 0, fadeOut: 1000};
    expect(splashState(p, 1450).opacity).toBeCloseTo(0.5);
    expect(splashState(p, 1450).animating).toBe(true);
    expect(splashState(p, 2000).animating).toBe(false);
    expect(splashState(p, 60 * 60_000)).toMatchObject({animating: false}); // an hour later: still nothing to animate
  });
});
