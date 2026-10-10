import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {addMarketplace, applyItem, installedItems, loadMarketplaces, normalizeUrl, OFFICIAL_URL, pluginsDir, readCatalog, removeMarketplace, repoUrls, unapplyItem, updatesFor} from '../src/marketplace/index.js';
import {installItem, uninstallItem} from '../src/marketplace/actions.js';
import {suggestCommands} from '../src/commands/index.js';
import {loadSkills} from '../src/skills/index.js';

const w = (f: string, s: string) => {
  mkdirSync(path.dirname(f), {recursive: true});
  writeFileSync(f, s);
};
const j = (f: string, o: unknown) => w(f, JSON.stringify(o));

/** A Rein-layout marketplace: a skill, a theme, a pack switch and a bundle of two of them. */
function reinMarket(dir: string, version = '1.0.0') {
  j(path.join(dir, 'marketplace.json'), {name: 'Test Market', description: 'For tests'});
  j(path.join(dir, 'items/commits/rein.json'), {id: 'commits', name: 'Commits', version, description: 'Commit messages', category: 'skills'});
  w(path.join(dir, 'items/commits/skills/write/SKILL.md'), '---\nname: write\ndescription: Write a commit message\n---\nWrite one.');
  j(path.join(dir, 'items/violet/rein.json'), {id: 'violet', name: 'Violet', version: '1.0.0', description: 'A theme', theme: {accent: '#a78bfa'}});
  j(path.join(dir, 'items/pack-ci/rein.json'), {id: 'pack-ci', name: 'CI pack', version: '1.0.0', description: 'CI', config: {packs: ['ci']}});
  j(path.join(dir, 'items/starter/rein.json'), {id: 'starter', name: 'Starter', version: '1.0.0', description: 'Both', requires: ['commits', 'pack-ci']});
  w(path.join(dir, 'items/starter/README.md'), '# Starter\n\nEverything a team needs.');
}

let home: string;
let official: string;
const saved = {home: process.env.REIN_HOME, official: process.env.REIN_OFFICIAL_MARKETPLACE};
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'rein-market-'));
  official = path.join(home, 'official');
  reinMarket(official);
  process.env.REIN_HOME = path.join(home, 'rein');
  process.env.REIN_OFFICIAL_MARKETPLACE = official;
});
afterEach(() => {
  for (const [k, v] of [['REIN_HOME', saved.home], ['REIN_OFFICIAL_MARKETPLACE', saved.official]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Settings in memory, standing in for the runtime. */
const host = () => {
  const h = {config: {packs: [], experiments: []} as any, async setConfig(p: any) {
    h.config = {...h.config, ...p};
  }};
  return h;
};

describe('marketplaces', () => {
  it('spells repo URLs one way', () => {
    expect(normalizeUrl('github.com/a/b')).toBe('https://github.com/a/b');
    expect(normalizeUrl('a/b')).toBe('https://github.com/a/b');
    expect(normalizeUrl('git@github.com:a/b.git')).toBe('https://github.com/a/b');
    expect(normalizeUrl('https://github.com/a/b.git/')).toBe('https://github.com/a/b');
    expect(OFFICIAL_URL).toBe('https://github.com/rein-harness/rein-marketplace');
  });

  it('always has the official one first, which cannot be removed', async () => {
    const [m] = await loadMarketplaces();
    expect(m!.official).toBe(true);
    expect(m!.name).toBe('Test Market');
    expect(m!.items.map((i) => [i.id, i.category])).toEqual([['commits', 'skills'], ['pack-ci', 'feature'], ['starter', 'bundle'], ['violet', 'ui']]);
    expect(m!.items.find((i) => i.id === 'starter')!.readme).toContain('Everything a team needs');
    expect(() => removeMarketplace(official)).toThrow(/built in and can't be removed/);
  });

  it('adds and removes repos: Rein layout, Claude Code layout, a real git repo; refuses non-marketplaces', async () => {
    // A Claude Code marketplace: plugins in folders of the repo.
    const claude = path.join(home, 'claude-market');
    j(path.join(claude, '.claude-plugin/marketplace.json'), {name: 'cc-market', plugins: [{name: 'lint', source: './plugins/lint', description: 'Lint things'}, {name: 'remote', source: {source: 'github', repo: 'x/y'}}]});
    w(path.join(claude, 'plugins/lint/commands/run.md'), 'Run the linter.');
    const added = await addMarketplace(claude);
    expect(added.items.map((i) => [i.id, i.category, i.adds.commands])).toEqual([['lint', 'commands', 1]]);
    await expect(addMarketplace(claude)).rejects.toThrow(/already in your marketplaces/);
    const empty = path.join(home, 'empty');
    mkdirSync(empty);
    await expect(addMarketplace(empty)).rejects.toThrow(/isn't a marketplace/);
    // A git repo by URL (file://: no network): cloned into ~/.rein/marketplaces/.
    const repo = path.join(home, 'git-market');
    reinMarket(repo, '2.0.0');
    const git = (...a: string[]) => execFileSync('git', a, {cwd: repo, stdio: 'ignore', env: {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'}});
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'items');
    const url = pathToFileURL(repo).href;
    const fromGit = await addMarketplace(url);
    expect(fromGit.items.find((i) => i.id === 'commits')!.version).toBe('2.0.0');
    expect(existsSync(fromGit.dir)).toBe(true);
    expect(repoUrls()).toHaveLength(3);
    removeMarketplace(url);
    expect(existsSync(fromGit.dir)).toBe(false);
    removeMarketplace(claude);
    expect(repoUrls()).toEqual([official]);
  });

  it('installs a bundle with what it needs, loads its skills, and undoes its settings on uninstall', async () => {
    const h = host();
    const all = (await loadMarketplaces()).flatMap((m) => m.items);
    const r = await installItem(h, all, 'starter');
    expect(r.lines.map((l) => l.split(' (')[0])).toEqual(['Installed Commits 1.0.0', 'Installed CI pack 1.0.0', 'Installed Starter 1.0.0']);
    expect(r.restart).toBe(false);
    expect(installedItems().map((i) => i.id).sort()).toEqual(['commits', 'pack-ci', 'starter']);
    expect(h.config.packs).toEqual(['ci']);
    // The skill loads like a plugin's, and shows in a bare `/` list (you chose to install it).
    const skill = loadSkills(home).find((s) => s.name === 'commits:write');
    expect(skill?.marketplace).toBe(true);
    expect(suggestCommands('/', loadSkills(home)).map((c) => c.name)).toContain('commits:write');
    expect(existsSync(path.join(pluginsDir(), 'commits', '.claude-plugin', 'plugin.json'))).toBe(true);
    await uninstallItem(h, 'pack-ci');
    expect(h.config.packs).toEqual([]);
    await expect(uninstallItem(h, 'pack-ci')).rejects.toThrow(/isn't installed/);
  });

  it('applies a theme and restores the previous one, unless you changed it since', () => {
    const it = {theme: {accent: '#a78bfa'}};
    const before = {theme: {accent: 'green'}};
    const change = applyItem(before, it)!;
    expect(change.patch.theme).toEqual({accent: '#a78bfa'});
    expect(unapplyItem({theme: {accent: '#a78bfa'}}, change.applied)).toEqual({theme: {accent: 'green'}});
    expect(unapplyItem({theme: {accent: 'red'}}, change.applied)).toBeUndefined(); // you changed it: kept
    expect(applyItem({packs: ['ci']}, {config: {packs: ['ci']}})).toBeUndefined(); // already on: nothing to do
  });

  it('finds updates to what you installed', async () => {
    const all = (await loadMarketplaces()).flatMap((m) => m.items);
    await installItem(host(), all, 'commits');
    reinMarket(official, '1.1.0');
    expect(updatesFor(await loadMarketplaces())).toEqual([{id: 'commits', from: '1.0.0', to: '1.1.0'}]);
    expect(readCatalog(official, official).items.find((i) => i.id === 'commits')!.version).toBe('1.1.0');
  });
});
