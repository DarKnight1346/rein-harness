import type {Config} from '../store/config.js';
import {resetPluginCache} from '../plugins/index.js';
import {applyItem, install, installedItems, recordApplied, unapplyItem, uninstall, withRequirements, type Item} from './index.js';

type Host = {config: Config; setConfig(patch: Partial<Config>): Promise<void>};

/** Install an item and what it requires; returns a line per item, and whether a restart is needed. */
export async function installItem(host: Host, all: Item[], id: string): Promise<{lines: string[]; restart: boolean}> {
  const {items, missing} = withRequirements(all, id);
  if (missing.length) throw new Error(`${id} needs ${missing.join(', ')}, which no marketplace you've added has`);
  const lines: string[] = [];
  let restart = false;
  for (const it of items) {
    const was = installedItems().find((i) => i.id === it.id);
    if (was && was.version === it.version && it.id !== id) continue; // a requirement that's already there
    install(it);
    const change = applyItem(host.config, it);
    if (change) {
      await host.setConfig(change.patch as Partial<Config>);
      recordApplied(it.id, change.applied);
    }
    // MCP servers and hooks start with Rein; skills and commands are there right away.
    if (it.adds.mcp.length || it.adds.hooks.length) restart = true;
    lines.push(`${was ? `Updated ${it.name} ${was.version} → ${it.version}` : `Installed ${it.name} ${it.version}`}${describe(it)}`);
  }
  resetPluginCache();
  return {lines, restart};
}

export async function uninstallItem(host: Host, id: string): Promise<string> {
  const rec = installedItems().find((i) => i.id === id);
  if (!rec) throw new Error(`${id} isn't installed (/marketplace shows what is)`);
  const undo = unapplyItem(host.config, rec.applied);
  if (undo) await host.setConfig(undo as Partial<Config>);
  uninstall(id);
  resetPluginCache();
  return `Uninstalled ${id}${undo ? ' and undid its settings' : ''}.`;
}

/** What an item adds, in a few words: " (2 skills, 1 command, MCP: github)". */
export function describe(it: Item): string {
  const a = it.adds;
  const parts = [
    a.skills && `${a.skills} skill${a.skills > 1 ? 's' : ''}`,
    a.commands && `${a.commands} command${a.commands > 1 ? 's' : ''}`,
    a.agents && `${a.agents} subagent${a.agents > 1 ? 's' : ''}`,
    a.mcp.length && `tools from ${a.mcp.join(', ')}`,
    a.hooks.length && `hooks on ${a.hooks.join(', ')}`,
    it.theme && 'a theme',
    it.config?.packs?.length && `packs ${it.config.packs.join(', ')}`,
    it.config?.experiments?.length && `experiments ${it.config.experiments.join(', ')}`,
    (it.config?.statusLine || it.config?.sidebarSections) && 'a layout',
    it.requires.length && `with ${it.requires.join(', ')}`,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
