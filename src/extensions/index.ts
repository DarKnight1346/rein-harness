import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {reinHome} from '../store/paths.js';
import {API_VERSION, type Command, type Rein, type SidebarSection, type StatusSegment, type Theme, type Tool} from './api.js';

/**
 * Extensions: the code marketplace items ship (extensions/api.ts is what they get). Installed items
 * live in ~/.rein/plugins/<id>/; one whose rein.json has `main` is imported and its `activate(rein)`
 * called. What they register (commands, tools, sidebar sections, status segments, a theme) is kept
 * here, by item, so an item can be unloaded when it's updated or uninstalled.
 */
export type Host = {
  cwd(): string;
  config(): Record<string, unknown>;
  registerTool(item: string, t: Tool): void;
  exec(command: string, args: string[], opts?: {cwd?: string; timeoutMs?: number}): Promise<{code: number; stdout: string; stderr: string}>;
  ripgrep(): Promise<string | undefined>;
  workspace(): ReturnType<Rein['workspace']>;
};
type Owned<T> = {item: string; value: T};

const pluginsDir = () => path.join(reinHome(), 'plugins');
const readJson = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};

/** The items that ship code: their folder, rein.json and main file. */
export function codeItems(dir = pluginsDir()): {id: string; dir: string; main: string; api: number}[] {
  if (!existsSync(dir)) return [];
  const out: {id: string; dir: string; main: string; api: number}[] = [];
  for (const d of readdirSync(dir)) {
    const m = readJson(path.join(dir, d, 'rein.json'));
    if (typeof m?.main !== 'string') continue;
    const main = path.resolve(dir, d, m.main);
    if (!main.startsWith(path.join(dir, d) + path.sep)) continue; // never outside the item
    out.push({id: d, dir: path.join(dir, d), main, api: Number(m.api ?? 1)});
  }
  return out;
}

/** A hash of an item's files, so an update (new code) loads fresh and the store can say what changed. */
export function itemHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(e.name).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

export class Extensions extends EventEmitter {
  readonly commands: Owned<Command>[] = [];
  readonly sidebar: Owned<SidebarSection>[] = [];
  readonly status: Owned<StatusSegment>[] = [];
  readonly themes: Owned<Theme>[] = [];
  readonly loaded = new Map<string, string>(); // id → hash
  readonly errors = new Map<string, string>();
  private settingsFile = (id: string) => path.join(reinHome(), 'plugin-data', id, 'settings.json');

  /** The theme the most recently loaded theme item set (undefined: none). */
  get theme(): Theme | undefined {
    return this.themes.at(-1)?.value;
  }

  command(name: string): Command | undefined {
    return this.commands.find((c) => c.value.name === name)?.value;
  }

  /** Load every installed code item not loaded yet (or changed since). Returns what it loaded and what failed. */
  async loadAll(host: Host, dir = pluginsDir()): Promise<{loaded: string[]; failed: {id: string; error: string}[]}> {
    const loaded: string[] = [];
    const failed: {id: string; error: string}[] = [];
    for (const it of codeItems(dir)) {
      const hash = itemHash(it.dir);
      if (this.loaded.get(it.id) === hash) continue;
      this.unload(it.id);
      try {
        if (it.api > API_VERSION) throw new Error(`it needs extension API ${it.api}; this Rein has ${API_VERSION} (update Rein: /update)`);
        // The hash in the URL: an updated item's code is imported fresh, not from Node's module cache.
        const mod = await import(`${pathToFileURL(it.main).href}?v=${hash}`);
        const activate = mod.activate ?? mod.default?.activate ?? mod.default;
        if (typeof activate !== 'function') throw new Error(`${path.basename(it.main)} has no activate(rein) export`);
        await activate(this.api(it.id, it.dir, host));
        this.loaded.set(it.id, hash);
        this.errors.delete(it.id);
        loaded.push(it.id);
      } catch (err) {
        this.unload(it.id);
        const error = (err as Error).message;
        this.errors.set(it.id, error);
        failed.push({id: it.id, error});
      }
    }
    // Items that were removed: forget what they registered.
    for (const id of [...this.loaded.keys()]) if (!codeItems(dir).some((i) => i.id === id)) this.unload(id);
    this.emit('change');
    return {loaded, failed};
  }

  /** Forget everything an item registered (its tools stay until Rein restarts: the agent's tool list is fixed per session). */
  unload(id: string): void {
    for (const list of [this.commands, this.sidebar, this.status, this.themes] as Owned<unknown>[][]) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.item === id) list.splice(i, 1);
    }
    this.loaded.delete(id);
    this.emit('change');
  }

  private api(id: string, dir: string, host: Host): Rein {
    const dataDir = path.join(reinHome(), 'plugin-data', id);
    const own = <T>(list: Owned<T>[], value: T, key: (v: T) => string) => {
      const k = key(value);
      const at = list.findIndex((x) => x.item === id && key(x.value) === k);
      if (at >= 0) list.splice(at, 1);
      list.push({item: id, value});
      this.emit('change');
    };
    const settings = (): Record<string, unknown> => readJson(this.settingsFile(id)) ?? {};
    return {
      version: API_VERSION,
      item: {id, dir, dataDir},
      registerCommand: (c) => {
        if (!/^[a-z][\w:-]*$/.test(c.name ?? '')) throw new Error(`a command name is letters, digits, - and : (got ${c.name})`);
        own(this.commands, c, (x) => x.name);
      },
      registerTool: (t) => {
        if (!/^[a-zA-Z][\w-]{0,63}$/.test(t.name ?? '')) throw new Error(`a tool name is letters, digits, _ and - (got ${t.name})`);
        host.registerTool(id, t);
      },
      ui: {
        sidebarSection: (s) => own(this.sidebar, s, (x) => x.id),
        statusSegment: (s) => own(this.status, s, (x) => x.id),
        theme: (t) => own(this.themes, t, () => 'theme'),
        redraw: () => this.emit('change'),
      },
      exec: (command, args, opts) => host.exec(command, args, {cwd: opts?.cwd ?? host.cwd(), ...(opts?.timeoutMs ? {timeoutMs: opts.timeoutMs} : {})}),
      git: (args, cwd) => host.exec('git', args, {cwd: cwd ?? host.cwd()}),
      ripgrep: () => host.ripgrep(),
      workspace: () => host.workspace(),
      config: () => ({...host.config()}),
      settings: {
        get: <T>(key: string) => settings()[key] as T | undefined,
        set: (key, value) => {
          mkdirSync(dataDir, {recursive: true});
          writeFileSync(this.settingsFile(id), JSON.stringify({...settings(), [key]: value}, null, 2) + '\n');
        },
      },
      on: (event, fn) => {
        this.on(event, fn);
        return () => void this.off(event, fn);
      },
    };
  }
}

export const extensions = new Extensions();
