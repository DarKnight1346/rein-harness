#!/usr/bin/env node
// A recorder for tests, like sox `rec`: records "audio" until SIGINT, then writes a valid WAV.
// The output file is the first argument that ends in .wav.
import {writeFileSync} from 'node:fs';
const out = process.argv.find((a) => a.endsWith('.wav'));
const started = Date.now();
const finish = () => {
  const samples = Math.max(1600, Math.round(((Date.now() - started) / 1000) * 16000));
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(out, Buffer.concat([h, data]));
  process.exit(0);
};
process.on('SIGINT', finish);
setInterval(() => {}, 1000);
