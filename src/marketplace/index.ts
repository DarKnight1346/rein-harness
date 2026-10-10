import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {reinHome} from '../store/paths.js';
import {run} from '../util/proc.js';

/**
 * The marketplace: git repos laid out as catalogs of things to add to Rein. An item adds tools (MCP
 * servers), commands, skills, subagents, hooks, UI customization or settings, or bundles other
 * items. Installing copies the item into ~/.rein/plugins/<id>/, where Rein loads it like a Claude
 * Code plugin (plugins/index.ts), and applies its settings and theme.
 *
 * A repo is a marketplace when it has `marketplace.json` (Rein's: name, description) with items in
 * `items/<id>/rein.json`, or a Claude Code marketplace (`.claude-plugin/marketplace.json`, its
 * plugins in folders of the repo). The official Rein Marketplace is always there.
 */
/** The official Rein Marketplace. REIN_OFFICIAL_MARKETPLACE points it at a mirror (or a folder, in tests). */
export const OFFICIAL_URL = 'https://github.com/rein-harness/rein-marketplace';
export const official = () => process.env.REIN_OFFICIAL_MARKETPLACE || OFFICIAL_URL;

export type Category = 'tools' | 'commands' | 'skills' | 'ui' | 'feature' | 'bundle';
export const CATEGORIES: {id: Category; label: string}[] = [
  {id: 'tools', label: 'Tools'},
  {id: 'commands', label: 'Commands'},
  {id: 'skills', label: 'Skills'},
  {id: 'ui', label: 'UI'},
  {id: 'feature', label: 'Features'},
  {id: 'bundle', label: 'Bundles'},
];

/** What an item changes in Rein's settings and look (applied on install, undone on uninstall). */
export type ItemConfig = {experiments?: string[]; statusLine?: string[]; sidebarSections?: string[]};
export type Theme = {accent?: string};

export type Item = {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  category: Category;
  tags: string[];
  icon?: string;
  homepage?: string;
  /** Other items (same marketplace) this one installs too: a bundle. */
  requires: string[];
  config?: ItemConfig;
  theme?: Theme;
  /** What it adds, counted from its folder, for the store page. */
  adds: {commands: number; skills: number; agents: number; mcp: string[]; hooks: string[]; code?: boolean};
  readme?: string;
  dir: string;
  marketplace: string;
};

export type Marketplace = {url: string; name: string; description?: string; official: boolean; dir: string; items: Item[]; error?: string; updatedAt?: number};
/** What installing changed, so uninstalling undoes only that: the experiments it turned on, and the layout and theme it replaced. */
export type Applied = {experiments?: string[]; previous?: {statusLine?: string[]; sidebarSections?: string[]; theme?: Theme}; set?: {statusLine?: string[]; sidebarSections?: string[]; theme?: Theme}};
export type Installed = {id: string; marketplace: string; version: string; installedAt: number; applied?: Applied};
type Settings = {experiments?: string[]; statusLine?: string[]; sidebarSections?: string[]; theme?: Theme};

const root = () => path.join(reinHome(), 'marketplaces');
const reposFile = () => path.join(reinHome(), 'marketplaces.json');
const installedFile = () => path.join(reinHome(), 'plugins.json');
export const pluginsDir = () => path.join(reinHome(), 'plugins');

const readJson = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A repo URL in one spelling (github.com/x/y, https://github.com/x/y.git → https://github.com/x/y). Local folders stay paths. */
export function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) return `https://github.com/${u}`;
  if (/^(github\.com|gitlab\.com|bitbucket\.org)\//.test(u)) return `https://${u}`;
  const ssh = u.match(/^git@([\w.-]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return u;
}
const slug = (url: string) => normalizeUrl(url).replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_');
const isLocal = (url: string) => !/^[a-z]+:\/\//i.test(url) && (path.isAbsolute(url) || url.startsWith('.'));

/** The repos you've added, with the official one first (it can't be removed). */
export function repoUrls(): string[] {
  const added = (readJson(reposFile())?.repos ?? []).map((r: any) => String(r.url ?? r)).filter(Boolean) as string[];
  return [official(), ...added.filter((u) => normalizeUrl(u) !== normalizeUrl(official()))];
}

function saveRepos(urls: string[]): void {
  mkdirSync(reinHome(), {recursive: true});
  writeFileSync(reposFile(), JSON.stringify({repos: urls.filter((u) => normalizeUrl(u) !== normalizeUrl(official())).map((url) => ({url}))}, null, 2) + '\n');
}

const git = (args: string[], cwd?: string) => run('git', args, {cwd, timeoutMs: 120_000}).catch((err) => ({code: 1, stdout: '', stderr: (err as Error).message}));

/** Clone a repo, or bring its copy up to date (shallow). A local folder is read where it is. */
async function fetchRepo(url: string): Promise<{dir: string; error?: string}> {
  if (isLocal(url)) return {dir: path.resolve(url)};
  const dir = path.join(root(), slug(url));
  if (existsSync(path.join(dir, '.git'))) {
    const r = await git(['pull', '--ff-only', '--depth', '1'], dir);
    if (r.code !== 0) {
      // A force-pushed or rewritten repo: start over.
      rmSync(dir, {recursive: true, force: true});
    } else return {dir};
  }
  mkdirSync(root(), {recursive: true});
  const r = await git(['clone', '--depth', '1', '--quiet', normalizeUrl(url), dir]);
  if (r.code !== 0) {
    const why = /not found|does not exist|Repository not found/i.test(r.stderr) ? "the repo doesn't exist or isn't public" : /ENOENT|not recognized|command not found/i.test(r.stderr) ? 'git is not installed' : (r.stderr.trim().split('\n').pop() ?? 'git clone failed');
    return {dir, error: why};
  }
  return {dir};
}

const count = (dir: string, test: (f: string) => boolean): number => (isDir(dir) ? readdirSync(dir, {recursive: true, encoding: 'utf8'}).filter(test).length : 0);

/** What a plugin-style folder adds. */
function addsOf(dir: string): Item['adds'] {
  const mcp = readJson(path.join(dir, '.mcp.json'));
  const servers = mcp?.mcpServers ?? mcp ?? {};
  const hooks = readJson(path.join(dir, 'hooks', 'hooks.json'));
  return {
    commands: count(path.join(dir, 'commands'), (f) => f.endsWith('.md')),
    skills: count(path.join(dir, 'skills'), (f) => path.basename(f) === 'SKILL.md'),
    agents: count(path.join(dir, 'agents'), (f) => f.endsWith('.md')),
    mcp: Object.keys(servers && typeof servers === 'object' ? servers : {}),
    hooks: Object.keys(hooks?.hooks ?? hooks ?? {}),
  };
}

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
function guessCategory(adds: Item['adds'], m: any): Category {
  if (m.theme) return 'ui';
  if (adds.mcp.length) return 'tools';
  if (adds.skills && !adds.commands) return 'skills';
  if (adds.commands) return 'commands';
  return 'feature';
}

function item(dir: string, m: any, marketplace: string, fallbackId: string): Item | undefined {
  const id = String(m.id ?? m.name ?? fallbackId).toLowerCase().replace(/[^\w-]+/g, '-');
  if (!id) return undefined;
  const adds = {...addsOf(dir), ...(typeof m.main === 'string' ? {code: true} : {})};
  const readme = ['README.md', 'readme.md'].map((f) => path.join(dir, f)).find(existsSync);
  return {
    id,
    name: String(m.displayName ?? m.title ?? m.name ?? id),
    version: String(m.version ?? '0.0.0'),
    description: String(m.description ?? ''),
    ...(m.author ? {author: typeof m.author === 'string' ? m.author : String(m.author.name ?? '')} : {}),
    category: CATEGORY_IDS.has(m.category) ? m.category : Array.isArray(m.requires) && m.requires.length ? 'bundle' : guessCategory(adds, m),
    tags: Array.isArray(m.tags ?? m.keywords) ? (m.tags ?? m.keywords).map(String) : [],
    ...(typeof m.icon === 'string' ? {icon: m.icon} : {}),
    ...(typeof m.homepage === 'string' ? {homepage: m.homepage} : {}),
    requires: Array.isArray(m.requires) ? m.requires.map(String) : [],
    ...(m.config && typeof m.config === 'object' ? {config: m.config as ItemConfig} : {}),
    ...(m.theme && typeof m.theme === 'object' ? {theme: m.theme as Theme} : {}),
    adds,
    ...(readme ? {readme: readFileSync(readme, 'utf8').slice(0, 20_000)} : {}),
    dir,
    marketplace,
  };
}

/** The items of a repo checked out at `dir`, in either layout. */
export function readCatalog(dir: string, url: string): Omit<Marketplace, 'official' | 'dir'> {
  const own = readJson(path.join(dir, 'marketplace.json'));
  const claude = readJson(path.join(dir, '.claude-plugin', 'marketplace.json'));
  const items: Item[] = [];
  const within = (rel: string) => {
    const p = path.resolve(dir, rel);
    return p === dir || p.startsWith(dir + path.sep) ? p : undefined;
  };
  const itemsDir = path.join(dir, 'items');
  if (isDir(itemsDir))
    for (const d of readdirSync(itemsDir).sort()) {
      const m = readJson(path.join(itemsDir, d, 'rein.json'));
      const it = m ? item(path.join(itemsDir, d), m, url, d) : undefined;
      if (it) items.push(it);
    }
  // Claude Code's marketplace: plugins in folders of the repo (other sources aren't fetched).
  for (const p of claude?.plugins ?? []) {
    const src = typeof p?.source === 'string' ? within(p.source) : undefined;
    if (!src || !isDir(src) || items.some((i) => i.id === String(p.name))) continue;
    const manifest = readJson(path.join(src, '.claude-plugin', 'plugin.json')) ?? {};
    const it = item(src, {...manifest, ...p, ...readJson(path.join(src, 'rein.json'))}, url, String(p.name));
    if (it) items.push(it);
  }
  const name = String(own?.name ?? claude?.name ?? path.basename(normalizeUrl(url)));
  return {url, name, ...(own?.description || claude?.metadata?.description ? {description: String(own?.description ?? claude.metadata.description)} : {}), items};
}

/** Every marketplace with its items; fetched (or refreshed) when `refresh` or not yet on disk. */
export async function loadMarketplaces(opts: {refresh?: boolean} = {}): Promise<Marketplace[]> {
  const out: Marketplace[] = [];
  for (const url of repoUrls()) {
    const local = isLocal(url);
    const dir = local ? path.resolve(url) : path.join(root(), slug(url));
    let error: string | undefined;
    if (!local && (opts.refresh || !isDir(dir))) error = (await fetchRepo(url)).error;
    const isOfficial = normalizeUrl(url) === normalizeUrl(official());
    if (!isDir(dir)) {
      out.push({url, name: isOfficial ? 'Rein Marketplace' : url, official: isOfficial, dir, items: [], error: error ?? 'not downloaded yet'});
      continue;
    }
    const c = readCatalog(dir, url);
    const updated = isDir(path.join(dir, '.git')) ? statSync(path.join(dir, '.git')).mtimeMs : undefined;
    out.push({...c, name: isOfficial && c.name === 'rein-marketplace' ? 'Rein Marketplace' : c.name, official: isOfficial, dir, ...(error ? {error} : {}), ...(updated ? {updatedAt: updated} : {})});
  }
  return out;
}

export async function addMarketplace(url: string): Promise<Marketplace> {
  const u = isLocal(url) ? path.resolve(url) : normalizeUrl(url);
  if (!isLocal(url) && !/^(https?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+|file:\/\/\/|(ssh|git):\/\/)/.test(u)) throw new Error(`${url} isn't a git repo URL (like https://github.com/owner/repo)`);
  if (repoUrls().some((r) => normalizeUrl(r) === normalizeUrl(u))) throw new Error(`${u} is already in your marketplaces`);
  const {dir, error} = await fetchRepo(u);
  if (error) throw new Error(`couldn't fetch ${u}: ${error}`);
  const c = readCatalog(dir, u);
  if (!c.items.length) {
    if (!isLocal(u)) rmSync(dir, {recursive: true, force: true});
    throw new Error(`${u} isn't a marketplace: no items/<id>/rein.json and no .claude-plugin/marketplace.json with plugins in the repo`);
  }
  saveRepos([...repoUrls(), u]);
  return {...c, official: false, dir};
}

export function removeMarketplace(url: string): string {
  const u = isLocal(url) ? path.resolve(url) : normalizeUrl(url);
  if (normalizeUrl(u) === normalizeUrl(official())) throw new Error("The Rein Marketplace is built in and can't be removed.");
  const urls = repoUrls();
  if (!urls.some((r) => normalizeUrl(r) === normalizeUrl(u))) throw new Error(`${u} isn't one of your marketplaces (/marketplace list)`);
  saveRepos(urls.filter((r) => normalizeUrl(r) !== normalizeUrl(u)));
  if (!isLocal(u)) rmSync(path.join(root(), slug(u)), {recursive: true, force: true});
  return u;
}

export function installedItems(): Installed[] {
  const list = readJson(installedFile())?.installed;
  return Array.isArray(list) ? list.filter((i: any) => i && typeof i.id === 'string' && isDir(path.join(pluginsDir(), i.id))) : [];
}
function saveInstalled(list: Installed[]): void {
  mkdirSync(reinHome(), {recursive: true});
  writeFileSync(installedFile(), JSON.stringify({installed: list}, null, 2) + '\n');
}

/** An item and every item it requires (a bundle), in install order; unknown ones are reported. */
export function withRequirements(all: Item[], id: string): {items: Item[]; missing: string[]} {
  const items: Item[] = [];
  const missing: string[] = [];
  const visit = (x: string, seen: Set<string>) => {
    if (items.some((i) => i.id === x) || seen.has(x)) return;
    const it = all.find((i) => i.id === x);
    if (!it) return void missing.push(x);
    seen.add(x);
    for (const r of it.requires) visit(r, seen);
    items.push(it);
  };
  visit(id, new Set());
  return {items, missing};
}

/**
 * Install an item (and what it requires): its folder goes to ~/.rein/plugins/<id>/ (replacing an
 * older version), and its settings and theme are returned for the caller to apply.
 */
export function install(it: Item): Installed {
  const dest = path.join(pluginsDir(), it.id);
  rmSync(dest, {recursive: true, force: true});
  mkdirSync(pluginsDir(), {recursive: true});
  cpSync(it.dir, dest, {recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src)});
  // Rein loads installed items as plugins: give one without a manifest the plugin layout's name.
  const manifest = path.join(dest, '.claude-plugin', 'plugin.json');
  mkdirSync(path.dirname(manifest), {recursive: true});
  try {
    writeFileSync(manifest, JSON.stringify({name: it.id, version: it.version, description: it.description}, null, 2) + '\n', {flag: 'wx'}); // unless the item has its own
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const old = installedItems().find((i) => i.id === it.id);
  const rec: Installed = {id: it.id, marketplace: it.marketplace, version: it.version, installedAt: Date.now(), ...(old?.applied ? {applied: old.applied} : {})};
  saveInstalled([...installedItems().filter((i) => i.id !== it.id), rec]);
  return rec;
}

/** The settings change an item's install makes, and the record that undoes it. */
export function applyItem(cfg: Settings, it: Pick<Item, 'config' | 'theme'>): {patch: Settings; applied: Applied} | undefined {
  const c = it.config ?? {};
  const patch: Settings = {};
  const applied: Applied = {};
  const add = (key: 'experiments') => {
    const now = cfg[key] ?? [];
    const extra = (c[key] ?? []).filter((x) => !now.includes(x));
    if (extra.length) {
      patch[key] = [...now, ...extra];
      applied[key] = extra;
    }
  };
  add('experiments');
  for (const key of ['statusLine', 'sidebarSections'] as const)
    if (c[key]) {
      patch[key] = c[key];
      (applied.previous ??= {})[key] = cfg[key];
      (applied.set ??= {})[key] = c[key];
    }
  if (it.theme) {
    patch.theme = {...cfg.theme, ...it.theme};
    (applied.previous ??= {}).theme = cfg.theme;
    (applied.set ??= {}).theme = patch.theme;
  }
  return Object.keys(patch).length ? {patch, applied} : undefined;
}

/** Undo an install's settings: what it turned on, and the layout and theme it set (unless you've changed them since). */
export function unapplyItem(cfg: Settings, a: Applied | undefined): Settings | undefined {
  if (!a) return undefined;
  const patch: Settings = {};
  for (const key of ['experiments'] as const) if (a[key]?.length && cfg[key]) patch[key] = cfg[key]!.filter((x) => !a[key]!.includes(x));
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  for (const key of ['statusLine', 'sidebarSections', 'theme'] as const)
    if (a.set && key in a.set && same(cfg[key], a.set[key])) (patch as any)[key] = a.previous?.[key];
  return Object.keys(patch).length ? patch : undefined;
}

/** Record what an install changed (after the caller applied the patch). */
export function recordApplied(id: string, applied: Applied): void {
  saveInstalled(installedItems().map((i) => (i.id === id ? {...i, applied} : i)));
}

export function uninstall(id: string): Installed | undefined {
  const rec = installedItems().find((i) => i.id === id);
  rmSync(path.join(pluginsDir(), id), {recursive: true, force: true});
  saveInstalled(installedItems().filter((i) => i.id !== id));
  return rec;
}

/** Installed items a newer version of which is in a marketplace. */
export function updatesFor(markets: Marketplace[]): {id: string; from: string; to: string}[] {
  const all = markets.flatMap((m) => m.items);
  return installedItems()
    .map((i) => ({i, it: all.find((x) => x.id === i.id)}))
    .filter(({i, it}) => it && it.version !== i.version)
    .map(({i, it}) => ({id: i.id, from: i.version, to: it!.version}));
}
