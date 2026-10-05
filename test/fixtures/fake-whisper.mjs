#!/usr/bin/env node
// whisper-cli for tests: checks it got a WAV (-f) and prints a fixed transcript, as -nt -np would.
import {readFileSync} from 'node:fs';
const wav = process.argv[process.argv.indexOf('-f') + 1];
if (readFileSync(wav).subarray(0, 4).toString() !== 'RIFF') {
  console.error('not a WAV');
  process.exit(1);
}
console.log(' [BLANK_AUDIO]\n Run the tests and fix what fails.\n');
