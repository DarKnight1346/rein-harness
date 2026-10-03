import {tierFrom} from '../tier.js';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {paths} from '../../store/paths.js';
import type {Account} from '../types.js';

const MAX_AGE_MS = 24 * 3600_000;

export const codexHome = (account: Account) => account.home ?? process.env.CODEX_HOME_DEFAULT ?? path.join(os.homedir(), '.codex');
const cachePath = (account: Account) => path.join(codexHome(account), 'models_cache.json');
export const reinCatalogPath = (account: Account) => path.join(paths.state(), 'codex-catalog', `${account.id}.json`);

type Cache = {fetched_at?: string; models: Record<string, unknown>[]};

export async function readModelsCache(account: Account): Promise<Cache | undefined> {
  try {
    return JSON.parse(await readFile(cachePath(account), 'utf8')) as Cache;
  } catch {
    return undefined;
  }
}

export function cacheIsFresh(cache: Cache | undefined, now = Date.now()): boolean {
  const t = cache?.fetched_at ? Date.parse(cache.fetched_at) : NaN;
  return Number.isFinite(t) && now - t < MAX_AGE_MS;
}

/**
 * Codex's built-in tools come from the model catalog (`tool_mode: "code_mode_only"`,
 * `apply_patch_tool_type`, `shell_type`), not from feature flags. Rein passes a copy with those
 * nulled via `-c model_catalog_json=…` (verified in M0 from a RUST_LOG=trace request capture).
 */
export function stripTools(cache: Cache): {models: Record<string, unknown>[]} {
  return {
    models: cache.models.map((m) => ({
      ...m,
      tool_mode: null,
      apply_patch_tool_type: null,
      shell_type: 'disabled',
      experimental_supported_tools: [],
      // v2 multi-agent injects spawn_agent/send_message/… even with the multi_agent feature off.
      multi_agent_version: null,
      node_repl_disabled: true,
      supports_search_tool: false,
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
    })),
  };
}

/** Write the tool-less catalog for an account; returns its path, or undefined without a cache. */
export async function writeReinCatalog(account: Account): Promise<string | undefined> {
  const cache = await readModelsCache(account);
  if (!cache?.models?.length) return undefined;
  const out = reinCatalogPath(account);
  await mkdir(path.dirname(out), {recursive: true, mode: 0o700});
  await writeFile(out, JSON.stringify(stripTools(cache)), {mode: 0o600});
  return out;
}

export async function contextWindows(account: Account): Promise<Map<string, number>> {
  const cache = await readModelsCache(account);
  return new Map((cache?.models ?? []).map((m) => [String(m.slug), Number(m.context_window) || 128_000]));
}

/** Relative cost tier from the model's own description (Codex exposes no prices). */
export const codexTier = (_id: string, description = '') => tierFrom(description);

/** App-server flags that remove Codex's built-in tools and extra prompt sections. */
export function appServerArgs(catalogPath: string | undefined): string[] {
  const disable = [
    'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'multi_agent',
    'plugins', 'remote_plugin', 'shell_tool', 'unified_exec', 'view_image', 'goals', 'sleep_tool',
    'tool_suggest', 'skill_search', 'collaboration_modes', 'hooks', 'in_app_browser',
    'workspace_dependencies', 'worktrees', 'code_mode_host',
  ];
  const config = [
    'web_search="disabled"',
    'include_permissions_instructions=false',
    'include_collaboration_mode_instructions=false',
    'include_environment_context=false',
    'include_apps_instructions=false',
    // Codex's bundled skills (imagegen, openai-docs, …) are listed in a developer message otherwise.
    'skills.include_instructions=false',
    'skills.bundled.enabled=false',
    // Rein puts AGENTS.md into its own system prompt for every provider; don't inject it twice.
    'project_doc_max_bytes=0',
    ...(catalogPath ? [`model_catalog_json=${JSON.stringify(catalogPath)}`] : []),
  ];
  return [...disable.flatMap((f) => ['--disable', f]), ...config.flatMap((c) => ['-c', c])];
}
