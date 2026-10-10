import {EventEmitter} from 'node:events';

/**
 * Previews: what the agent made that has a screen, so you can see it wherever you are. A web
 * server (`url`: shown in a browser that runs on this machine, streamed to you, so `localhost`
 * and the app's own API calls resolve here), or a display (`vnc`: a VM, an emulator, a desktop
 * app in a virtual display). They come from the agent's `preview` tool, or are noticed when a
 * command the agent started prints a local URL. Only previews in this registry can be opened:
 * the page names one by id, never an address.
 */
export type PreviewKind = 'url' | 'vnc';
export type Preview = {
  id: number;
  kind: PreviewKind;
  /** `url`: an http(s) URL. `vnc`: host:port. */
  target: string;
  title: string;
  /** Who found it: the agent asked to show it, or it appeared in a command's output. */
  source: 'agent' | 'detected';
  /** The shell whose output it came from (detected ones), so it goes when that command ends. */
  shellId?: number;
  createdAt: number;
};

/** A local URL in a command's output: what dev servers print when they're up. */
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/g;
// Terminal colors and the like around the URL (Vite prints them).
const ANSI = /\x1b\[[\d;]*[A-Za-z]/g;

/** Local URLs in text, normalized (0.0.0.0 → localhost, no trailing punctuation), first seen first. */
export function localUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(ANSI, '').matchAll(LOCAL_URL)) {
    let u = m[0].replace(/[.,;:!?]+$/, '');
    try {
      const url = new URL(u);
      if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
      u = url.toString();
    } catch {
      continue;
    }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** A VNC address: host:port, or a display number (`:1` is port 5901). */
export function vncTarget(text: string): string | undefined {
  const t = text.trim().replace(/^vnc:\/\//i, '');
  const display = t.match(/^(?:(\[[^\]]+\]|[\w.-]+))?:(\d{1,2})$/);
  if (display && Number(display[2]) < 100) return `${display[1] ?? 'localhost'}:${5900 + Number(display[2])}`;
  const hp = t.match(/^(\[[^\]]+\]|[\w.-]+):(\d{2,5})$/);
  return hp ? `${hp[1]}:${hp[2]}` : undefined;
}

export class Previews extends EventEmitter {
  private items: Preview[] = [];
  private nextId = 1;

  list(): Preview[] {
    return [...this.items];
  }

  get(id: number): Preview | undefined {
    return this.items.find((p) => p.id === id);
  }

  /** Add one (the same target again returns the existing one, renamed if the agent gave a title). */
  add(p: Omit<Preview, 'id' | 'createdAt'>): Preview {
    const same = this.items.find((x) => x.kind === p.kind && x.target === p.target);
    if (same) {
      if (p.source === 'agent') Object.assign(same, {title: p.title, source: 'agent'});
      this.emit('change');
      return same;
    }
    const added = {...p, id: this.nextId++, createdAt: Date.now()};
    this.items.push(added);
    this.emit('change');
    this.emit('added', added);
    return added;
  }

  remove(id: number): void {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length !== before) this.emit('change');
  }

  /** A command's output: any local URL in it becomes a preview (once). */
  detect(text: string, shellId?: number): Preview[] {
    return localUrls(text)
      .filter((u) => !this.items.some((x) => x.kind === 'url' && x.target === u))
      .map((u) => this.add({kind: 'url', target: u, title: new URL(u).host, source: 'detected', ...(shellId !== undefined ? {shellId} : {})}));
  }

  /** A command ended: what it served is gone (previews the agent asked for stay until it says). */
  shellEnded(shellId: number): void {
    const gone = this.items.filter((p) => p.source === 'detected' && p.shellId === shellId);
    if (!gone.length) return;
    this.items = this.items.filter((p) => !gone.includes(p));
    this.emit('change');
  }
}
