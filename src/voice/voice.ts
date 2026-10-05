import {spawn, type ChildProcess} from 'node:child_process';
import {createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {reinHome} from '../store/paths.js';
import {isWindows} from '../util/platform.js';

/**
 * Voice input, on-device: a recorder (sox `rec`, ffmpeg, or `arecord`) writes 16 kHz mono WAV,
 * whisper.cpp (`whisper-cli`) turns it into text. Nothing leaves the machine. The model is a
 * one-time download into `<data>/voice/`.
 */
export const DEFAULT_MODEL = 'base.en-q5_1';
export const MAX_RECORD_SECONDS = 120;
const MODEL_URL = (name: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

export const voiceDir = () => path.join(reinHome(), 'voice');
export const modelPath = (name = DEFAULT_MODEL) => path.join(voiceDir(), `ggml-${name}.bin`);

function onPath(bin: string): string | undefined {
  const exts = isWindows ? ['.exe', '.cmd', ''] : [''];
  // Homebrew's folders too: a GUI-launched terminal may not have them on the PATH.
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...(isWindows ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

export type Recorder = {kind: 'sox' | 'ffmpeg' | 'arecord'; command: string};
export type VoiceSetup = {recorder?: Recorder; whisper?: string; model: string; modelReady: boolean};

/** What's installed. `REIN_VOICE_*` override the commands (tests). */
export function detect(model = DEFAULT_MODEL): VoiceSetup {
  const env = process.env;
  let recorder: Recorder | undefined;
  if (env.REIN_VOICE_RECORDER) recorder = {kind: 'sox', command: env.REIN_VOICE_RECORDER};
  else {
    const rec = onPath('rec') ?? onPath('sox');
    const ffmpeg = onPath('ffmpeg');
    const arecord = process.platform === 'linux' ? onPath('arecord') : undefined;
    // Windows: ffmpeg needs a named dshow device, so only sox there.
    if (rec) recorder = {kind: 'sox', command: rec};
    else if (ffmpeg && !isWindows) recorder = {kind: 'ffmpeg', command: ffmpeg};
    else if (arecord) recorder = {kind: 'arecord', command: arecord};
  }
  const whisper = env.REIN_VOICE_WHISPER ?? onPath('whisper-cli') ?? onPath('whisper-cpp');
  const file = modelPath(model);
  return {recorder, whisper, model, modelReady: existsSync(file) && statSync(file).size > 1_000_000};
}

/** How to install what's missing, per platform (undefined = all there). */
export function installHint(s: VoiceSetup): {command?: string; text: string} | undefined {
  const missing = [!s.whisper && 'whisper.cpp', !s.recorder && 'a recorder (sox)'].filter(Boolean) as string[];
  if (!missing.length) return undefined;
  if (process.platform === 'darwin') {
    const pkgs = [!s.whisper && 'whisper-cpp', !s.recorder && 'sox'].filter(Boolean).join(' ');
    return {command: `brew install ${pkgs}`, text: `Voice needs ${missing.join(' and ')}: brew install ${pkgs}`};
  }
  if (process.platform === 'linux')
    return {text: `Voice needs ${missing.join(' and ')}. Install sox from your package manager (e.g. sudo apt install sox), and whisper.cpp (whisper-cli) from your package manager or https://github.com/ggml-org/whisper.cpp.`};
  return {text: `Voice needs ${missing.join(' and ')}: install sox (e.g. choco install sox.portable) and whisper.cpp from https://github.com/ggml-org/whisper.cpp/releases, and put whisper-cli on your PATH.`};
}

/** Download the speech model once (into a temp file, renamed when complete). */
export async function downloadModel(name = DEFAULT_MODEL, progress?: (done: number, total: number) => void): Promise<string> {
  const file = modelPath(name);
  mkdirSync(voiceDir(), {recursive: true});
  const res = await fetch(MODEL_URL(name));
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const tmp = `${file}.part`;
  let done = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (c: Buffer) => {
    done += c.length;
    if (progress && Date.now() - last > 500) {
      last = Date.now();
      progress(done, total);
    }
  });
  try {
    await pipeline(body, createWriteStream(tmp));
    if (total && statSync(tmp).size !== total) throw new Error(`download incomplete (${statSync(tmp).size} of ${total} bytes)`);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, {force: true});
    throw err;
  }
  return file;
}

function recorderArgs(r: Recorder, wav: string): string[] {
  const max = String(MAX_RECORD_SECONDS);
  // `rec` records from the default input; plain `sox` needs `-d` for it.
  if (r.kind === 'sox') return [...(/^sox(\.exe)?$/i.test(path.basename(r.command)) ? ['-d'] : []), '-q', '-c', '1', '-r', '16000', '-b', '16', wav, 'trim', '0', max];
  if (r.kind === 'ffmpeg') return ['-loglevel', 'error', '-f', process.platform === 'darwin' ? 'avfoundation' : 'alsa', '-i', process.platform === 'darwin' ? ':0' : 'default', '-ac', '1', '-ar', '16000', '-t', max, '-y', wav];
  return ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', max, wav];
}

/** A recording in progress: `stop()` ends it cleanly (the WAV header gets written) and returns the file. */
export class Recording {
  readonly wav = path.join(os.tmpdir(), `rein-voice-${process.pid}-${Date.now()}.wav`);
  private proc: ChildProcess;
  private exited: Promise<number | null>;
  private stderr = '';
  readonly startedAt = Date.now();

  constructor(private readonly recorder: Recorder) {
    this.proc = spawn(recorder.command, recorderArgs(recorder, this.wav), {stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true});
    this.proc.stderr?.on('data', (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    this.exited = new Promise((resolve) => {
      this.proc.on('error', (err) => {
        this.stderr += err.message;
        resolve(null);
      });
      this.proc.on('close', (code) => resolve(code));
    });
  }

  get running(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  async stop(): Promise<string> {
    if (this.running) {
      // ffmpeg finishes on "q"; sox and arecord on SIGINT. Never SIGKILL: the WAV would have no length.
      if (this.recorder.kind === 'ffmpeg') this.proc.stdin?.write('q');
      else this.proc.kill('SIGINT');
      const t = setTimeout(() => this.proc.kill('SIGTERM'), 3000);
      await this.exited;
      clearTimeout(t);
    } else await this.exited;
    if (!existsSync(this.wav) || statSync(this.wav).size < 1000) throw new Error(`nothing was recorded${this.stderr.trim() ? `: ${this.stderr.trim().split('\n').pop()}` : ' (is the microphone allowed for this terminal app?)'}`);
    return this.wav;
  }

  cancel(): void {
    if (this.running) this.proc.kill('SIGINT');
    void this.exited.then(() => rmSync(this.wav, {force: true}));
  }
}

/** WAV → text with whisper.cpp. */
export function transcribe(whisper: string, model: string, wav: string, language = model.includes('.en') ? 'en' : 'auto'): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const p = spawn(whisper, ['-m', modelPath(model), '-f', wav, '-nt', '-np', '-l', language, '-t', String(Math.max(1, Math.min(8, os.cpus().length)))], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper.cpp failed (exit ${code}): ${err.trim().split('\n').pop() ?? ''}`));
      // Drop whisper's non-speech markers ([BLANK_AUDIO], (music)…).
      resolve(out.replace(/\[[A-Z_ ]+\]|\((?:music|silence|inaudible)[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim());
    });
  });
}
