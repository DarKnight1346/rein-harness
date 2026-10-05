import {Text} from 'ink';
import {useEffect, useState} from 'react';
import {splashLines} from './splash.js';

export type SplashPhase = {fadeIn: number; fadeOut?: number};

const FADE_IN_MS = 700;
const FADE_OUT_MS = 900;
/** After the fade-in, the colors drift this long, then hold still. */
const DRIFT_MS = 6000;

/** Opacity at time `now`, and whether anything about it is still changing. */
export function splashState(phase: SplashPhase, now: number): {opacity: number; animating: boolean} {
  if (phase.fadeOut !== undefined) {
    const opacity = 1 - (now - phase.fadeOut) / FADE_OUT_MS;
    return {opacity, animating: opacity > 0};
  }
  const since = now - phase.fadeIn;
  return {opacity: Math.min(1, since / FADE_IN_MS), animating: since < FADE_IN_MS + DRIFT_MS};
}

export const splashHeight = (width: number) => splashLines(width, 1, 0).length;

/**
 * The blank-state splash: fades in, drifts its colors for a few seconds, then holds still, and
 * fades out after the first message. Every frame re-renders the whole screen (Ink redraws the
 * tree), so the timer runs only while something changes, and stops itself from its own clock:
 * nothing keeps it alive once the splash is done, even if a cleanup is missed.
 */
export function Splash({width, phase}: {width: number; phase: SplashPhase}) {
  const [tick, setTick] = useState(0);
  const {opacity, animating} = splashState(phase, Date.now());
  // ~20 fps while fading, a slow drift otherwise.
  const fading = phase.fadeOut !== undefined || Date.now() - phase.fadeIn < FADE_IN_MS;
  useEffect(() => {
    if (!animating) return;
    const t = setInterval(() => {
      if (!splashState(phase, Date.now()).animating) clearInterval(t);
      setTick((x) => x + 1);
    }, fading ? 50 : 150);
    return () => clearInterval(t);
  }, [phase, animating, fading]);
  if (opacity <= 0) return null;
  return (
    <>
      {splashLines(width, opacity, tick).map((l, i) => (
        <Text key={i} wrap="truncate">
          {l || ' '}
        </Text>
      ))}
    </>
  );
}
