import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
// The fakes run through their shebang: not on Windows.
const posix = process.platform === 'win32' ? describe.skip : describe;

beforeAll(() => {
  process.env.REIN_HOME = mkdtempSync(path.join(os.tmpdir(), 'rein-voice-'));
  process.env.REIN_VOICE_RECORDER = path.join(fixtures, 'fake-rec.mjs');
  process.env.REIN_VOICE_WHISPER = path.join(fixtures, 'fake-whisper.mjs');
});
afterAll(() => {
  for (const k of ['REIN_HOME', 'REIN_VOICE_RECORDER', 'REIN_VOICE_WHISPER']) delete process.env[k];
});

describe('voice setup', () => {
  it('needs the model before it is ready, and says how to install what is missing', async () => {
    const v = await import('../src/voice/voice.js');
    expect(v.detect().modelReady).toBe(false);
    expect(v.modelPath()).toBe(path.join(process.env.REIN_HOME!, 'voice', 'ggml-base.en-q5_1.bin'));
    mkdirSync(v.voiceDir(), {recursive: true});
    writeFileSync(v.modelPath(), Buffer.alloc(2_000_000));
    expect(v.detect().modelReady).toBe(true);
    expect(v.installHint(v.detect())).toBeUndefined();
    const hint = v.installHint({model: 'x', modelReady: true});
    expect(hint?.text).toMatch(/whisper\.cpp and a recorder/);
    if (process.platform === 'darwin') expect(hint?.command).toBe('brew install whisper-cpp sox');
  });
});

posix('voice recording', () => {
  it('records until stopped, then transcribes without whisper markers', async () => {
    const v = await import('../src/voice/voice.js');
    const s = v.detect();
    const rec = new v.Recording(s.recorder!);
    // Until the (fake) recorder has written something: node starting up takes longer on a busy machine.
    const {statSync} = await import('node:fs');
    for (let i = 0; i < 100 && !(statSync(rec.wav, {throwIfNoEntry: false})?.size ?? 0); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 200));
    const wav = await rec.stop();
    expect(await v.transcribe(s.whisper!, s.model, wav)).toBe('Run the tests and fix what fails.');
  }, 20_000);
});
