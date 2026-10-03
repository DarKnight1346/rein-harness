import {execFile} from 'node:child_process';
import {closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync} from 'node:fs';
import {copyFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import type {ImageInput} from '../providers/types.js';

const exec = promisify(execFile);

/**
 * What the prompt input holds besides typed text: big pastes, images (clipboard or dropped) and
 * dropped files, each shown as a placeholder token (`[Pasted text #1 +42 lines]`, `[Image #2]`,
 * `[File #3: notes.md]`) and expanded when the message is actually sent.
 */
export type Attachment = {kind: 'text'; text: string} | {kind: 'image'; image: ImageInput} | {kind: 'file'; path: string};

/** Pastes longer than this become a placeholder instead of flooding the input. */
const PASTE_LINES = 3;
const PASTE_CHARS = 800;
/** Dropped text files up to this size are inlined into the message. */
const MAX_INLINE_FILE = 256 * 1024;
/** Anthropic's per-image limit is 5 MB (base64); downscale anything bigger than this. */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

const IMAGE_MIME: Record<string, ImageInput['mime']> = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'};

export const TOKEN_RE = /\[(?:Pasted text|Image|File) #(\d+)[^\]]*\]/g;
/** A placeholder at the very end of the input (backspace deletes it whole). */
export const TRAILING_TOKEN_RE = /\[(?:Pasted text|Image|File) #\d+[^\]]*\]$/;

export class Attachments {
  private next = 1;
  private items = new Map<number, Attachment>();

  constructor(private readonly imageDir: () => string) {}

  private add(a: Attachment): number {
    const id = this.next++;
    this.items.set(id, a);
    return id;
  }

  /**
   * Turn a paste into what goes into the input: dropped file paths become `[Image #n]` / `[File #n]`,
   * a big paste becomes `[Pasted text #n +N lines]`, anything else is inserted as-is.
   */
  async paste(raw: string): Promise<string> {
    const text = raw.replace(/\r\n?/g, '\n');
    const dropped = droppedPaths(text);
    if (dropped) {
      const tokens: string[] = [];
      for (const p of dropped) tokens.push(await this.attachPath(p));
      return tokens.join(' ') + ' ';
    }
    const lines = text.split('\n').length;
    if (lines > PASTE_LINES || text.length > PASTE_CHARS) {
      const id = this.add({kind: 'text', text});
      return `[Pasted text #${id} +${lines} line${lines === 1 ? '' : 's'}]`;
    }
    return text;
  }

  /** A file dropped onto the terminal (its path was pasted). */
  async attachPath(file: string): Promise<string> {
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
    if (mime) {
      const image = await this.storeImage(file, mime);
      return `[Image #${this.add({kind: 'image', image})}]`;
    }
    return `[File #${this.add({kind: 'file', path: file})}: ${path.basename(file)}]`;
  }

  /** Ctrl+V: the clipboard's image (macOS), or undefined if it holds none. */
  async pasteClipboardImage(): Promise<string | undefined> {
    const file = path.join(this.dir(), `clipboard-${Date.now()}.png`);
    if (!(await readClipboardImage(file))) return undefined;
    const image = await this.fitImage({path: file, mime: 'image/png'});
    return `[Image #${this.add({kind: 'image', image})}]`;
  }

  /**
   * Expand placeholders for sending: pasted text inline, files as `<file>` blocks (or a note when
   * binary/too big), images kept as `[Image #n]` in the text and returned separately.
   */
  expand(text: string): {text: string; images: ImageInput[]} {
    const images: ImageInput[] = [];
    const files: string[] = [];
    const out = text.replace(TOKEN_RE, (token, n: string) => {
      const a = this.items.get(Number(n));
      if (!a) return token;
      if (a.kind === 'text') return a.text;
      if (a.kind === 'image') {
        images.push(a.image);
        return token;
      }
      files.push(fileBlock(a.path));
      return `[File #${n}: ${a.path}]`;
    });
    return {text: files.length ? `${out}\n\n${files.join('\n\n')}` : out, images};
  }

  /** Display form for the history: placeholders stay, so a 500-line paste doesn't flood the view. */
  hasTokens(text: string): boolean {
    TOKEN_RE.lastIndex = 0;
    return TOKEN_RE.test(text);
  }

  private dir(): string {
    const d = this.imageDir();
    mkdirSync(d, {recursive: true});
    return d;
  }

  /** Copy into the session's image folder (the original may move), downscaled if needed. */
  private async storeImage(file: string, mime: ImageInput['mime']): Promise<ImageInput> {
    const dest = path.join(this.dir(), `${Date.now()}-${path.basename(file)}`);
    await copyFile(file, dest);
    return this.fitImage({path: dest, mime});
  }

  private async fitImage(img: ImageInput): Promise<ImageInput> {
    if (statSync(img.path).size <= MAX_IMAGE_BYTES || process.platform !== 'darwin') return img;
    // sips ships with macOS: re-encode as JPEG at ≤2000px, which lands well under the limit.
    const out = img.path.replace(/\.[^.]+$/, '') + '-scaled.jpg';
    await exec('sips', ['-Z', '2000', '-s', 'format', 'jpeg', img.path, '--out', out]).catch(() => undefined);
    return existsSync(out) ? {path: out, mime: 'image/jpeg'} : img;
  }
}

/** `<file>` block for a dropped file: its text, or a note when it's binary or too big. */
function fileBlock(file: string): string {
  let fd: number | undefined;
  try {
    // One open: size and contents come from the same file even if the path changes meanwhile.
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size > MAX_INLINE_FILE) return `<file path="${file}">(${Math.round(size / 1024)} KB — too large to include; ask the user for the relevant part)</file>`;
    const buf = readFileSync(fd);
    if (buf.includes(0)) return `<file path="${file}">(binary file, ${Math.round(size / 1024)} KB — not included)</file>`;
    return `<file path="${file}">\n${buf.toString('utf8')}\n</file>`;
  } catch (err) {
    return `<file path="${file}">(could not read: ${(err as Error).message})</file>`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Terminals "drop" files by pasting their paths: quoted ('…' / "…"), or with backslash-escaped
 * spaces, separated by spaces. Returns the paths when the whole paste is existing files.
 */
export function droppedPaths(text: string): string[] | undefined {
  const s = text.trim();
  if (!s || s.includes('\n') || !/^['"]?(\/|~\/|file:\/\/)/.test(s)) return undefined;
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = '';
      else cur += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '\\' && i + 1 < s.length) cur += s[++i];
    else if (c === ' ') {
      if (cur) parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) parts.push(cur);
  const paths = parts.map((p) => {
    const q = p.startsWith('file://') ? decodeURIComponent(p.slice(7)) : p;
    return q.startsWith('~/') ? path.join(os.homedir(), q.slice(2)) : q;
  });
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  return paths.length && paths.every(isFile) ? paths : undefined;
}

/** Write the clipboard's image to `file` (PNG). macOS via AppleScript; Linux via wl-paste/xclip. */
async function readClipboardImage(file: string): Promise<boolean> {
  if (process.env.REIN_CLIPBOARD_IMAGE) {
    // Tests: a fixture instead of the user's clipboard.
    await copyFile(process.env.REIN_CLIPBOARD_IMAGE, file);
    return true;
  }
  try {
    if (process.platform === 'darwin') {
      const script = [
        'set png to (the clipboard as «class PNGf»)',
        `set f to open for access POSIX file ${JSON.stringify(file)} with write permission`,
        'write png to f',
        'close access f',
      ];
      await exec('osascript', script.flatMap((l) => ['-e', l]), {timeout: 5000});
    } else if (process.platform === 'linux') {
      const {stdout} = await exec('sh', ['-c', `(wl-paste --type image/png 2>/dev/null || xclip -selection clipboard -t image/png -o 2>/dev/null) > ${JSON.stringify(file)}`]);
      void stdout;
    } else return false;
    return existsSync(file) && statSync(file).size > 0;
  } catch {
    return false;
  }
}
