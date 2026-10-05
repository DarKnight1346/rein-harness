import {secretStore} from '../store/secrets.js';

/**
 * The secrets vault: values the agent can use in shell commands (as environment variables)
 * without ever seeing them. Values live in the OS keychain (or a 0600 / DPAPI file), are injected
 * only into the shells Rein starts, and are masked as `[secret:NAME]` wherever they would reach
 * the model: shell output, every tool result. Rein's own environment never gets them, so the
 * claude/codex CLIs, MCP servers, hooks and language servers don't either.
 */
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Shorter values aren't masked (masking "abc" would mangle ordinary output). */
export const MIN_MASK_LENGTH = 6;

type Entry = {value: string; at: string};

export class Vault {
  private store = secretStore('rein-vault', 'vault.json');
  private entries: Record<string, Entry> = {};
  private loaded = false;
  /** Every form of every value to mask, longest first (so a value inside another masks as the longer one). */
  private forms: {text: string; name: string}[] = [];
  private listeners = new Set<() => void>();

  async load(): Promise<void> {
    try {
      const raw = await this.store.get();
      this.entries = raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
    } catch {
      this.entries = {};
    }
    this.loaded = true;
    this.reindex();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  names(): string[] {
    return Object.keys(this.entries).sort();
  }

  /** For a shell's environment. */
  env(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.entries).map(([k, e]) => [k, e.value]));
  }

  async set(name: string, value: string): Promise<'keychain' | 'file'> {
    if (!NAME_RE.test(name)) throw new Error('names are letters, digits and _ (not starting with a digit), like GITHUB_TOKEN');
    if (!value) throw new Error('the value is empty');
    if (!this.loaded) await this.load();
    this.entries[name] = {value, at: new Date().toISOString()};
    const where = await this.store.set(JSON.stringify(this.entries));
    this.reindex();
    return where;
  }

  async remove(name: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    if (!(name in this.entries)) return false;
    delete this.entries[name];
    if (Object.keys(this.entries).length) await this.store.set(JSON.stringify(this.entries));
    else await this.store.delete();
    this.reindex();
    return true;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private reindex(): void {
    const forms: {text: string; name: string}[] = [];
    for (const [name, {value}] of Object.entries(this.entries)) {
      if (value.length < MIN_MASK_LENGTH) continue;
      for (const text of new Set(variants(value))) forms.push({text, name});
    }
    this.forms = forms.sort((a, b) => b.text.length - a.text.length);
    for (const fn of this.listeners) fn();
  }

  /** Replace every stored value (and its common encodings) with `[secret:NAME]`. */
  mask(text: string): string {
    if (!this.forms.length || !text) return text;
    let out = text;
    for (const {text: f, name} of this.forms) if (out.includes(f)) out = out.split(f).join(`[secret:${name}]`);
    return out;
  }
}

/** The forms a value commonly shows up in: as is, JSON-escaped, base64 (and URL-safe, unpadded), URL-encoded, hex. */
export function variants(value: string): string[] {
  const bytes = Buffer.from(value);
  const b64 = bytes.toString('base64');
  // base64 of the value followed by more bytes (`echo $X | base64` adds a newline) only shares the
  // whole 3-byte groups: mask those.
  const aligned = bytes.length % 3 ? bytes.subarray(0, bytes.length - (bytes.length % 3)).toString('base64') : b64;
  return [aligned, aligned.replace(/\+/g, '-').replace(/\//g, '_'),value, JSON.stringify(value).slice(1, -1), b64, b64.replace(/=+$/, ''), Buffer.from(value).toString('base64url'), encodeURIComponent(value), Buffer.from(value).toString('hex')].filter((v) => v.length >= MIN_MASK_LENGTH);
}
