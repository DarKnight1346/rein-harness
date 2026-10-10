import React, {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import chalk from 'chalk';
import {FRAME_MS, type Pets} from '../pets/index.js';
import type {Frame} from '../pets/sprite.js';

const cache = new WeakMap<Frame, string[]>();

/** A frame as text: each character is two pixels, ▀ with the top one as its colour and the bottom as its background. */
export function petLines(f: Frame): string[] {
  const hit = cache.get(f);
  if (hit) return hit;
  const px = (x: number, y: number) => {
    const i = (y * f.w + x) * 4;
    return f.px[i + 3] ? ([f.px[i]!, f.px[i + 1]!, f.px[i + 2]!] as const) : undefined;
  };
  const lines: string[] = [];
  for (let y = 0; y < f.h; y += 2) {
    let line = '';
    for (let x = 0; x < f.w; x++) {
      const top = px(x, y);
      const bottom = y + 1 < f.h ? px(x, y + 1) : undefined;
      if (top && bottom) line += chalk.rgb(...top).bgRgb(...bottom)('▀');
      else if (top) line += chalk.rgb(...top)('▀');
      else if (bottom) line += chalk.rgb(...bottom)('▄');
      else line += ' ';
    }
    lines.push(line.replace(/ +$/, ''));
  }
  cache.set(f, lines);
  return lines;
}

/** Your pet, animated to match what the agent is doing (pets/index.ts). Nothing while there's none. */
export function PetView({pets}: {pets: Pets}) {
  const [, redraw] = useState(0);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const on = () => {
      setFrame(0);
      redraw((n) => n + 1);
    };
    pets.on('change', on);
    pets.on('state', on);
    return () => {
      pets.off('change', on);
      pets.off('state', on);
    };
  }, [pets]);
  const frames = pets.frames?.states[pets.state];
  useEffect(() => {
    if (!frames?.length) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % frames.length), FRAME_MS[pets.state]);
    return () => clearInterval(t);
  }, [frames, pets.state]);
  if (!pets.pet || !frames?.length) return null;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {petLines(frames[frame % frames.length]!).map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
      <Text dimColor wrap="truncate">
        {pets.pet.name}
      </Text>
    </Box>
  );
}
