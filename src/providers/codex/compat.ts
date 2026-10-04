import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readJson, writeJson} from '../../store/json.js';
import {paths} from '../../store/paths.js';
import {run} from '../../util/proc.js';

/**
 * Codex's app-server protocol is experimental and changes between releases. Instead of finding
 * out mid-chat, Rein checks each new `codex` version once, against the protocol's own schema
 * (`codex app-server generate-json-schema --experimental`, no login or tokens needed), for every
 * method, notification and field Rein depends on. An incompatible Codex is switched off (Claude
 * keeps working) with a clear message, instead of breaking chats.
 */

const codexBin = () => process.env.REIN_CODEX_BIN ?? 'codex';

/** What Rein relies on. Keep in sync with adapter.ts / auth.ts / appServer.ts. */
export const REQUIRED = {
  requests: ['initialize', 'model/list', 'account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimits/read', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt'],
  notifications: ['item/agentMessage/delta', 'item/started', 'item/completed', 'turn/completed', 'thread/tokenUsage/updated', 'error', 'account/rateLimits/updated', 'account/login/completed'],
  serverRequests: ['item/tool/call', 'item/tool/requestUserInput'],
  fields: {
    InitializeCapabilities: ['experimentalApi'],
    ThreadStartParams: ['model', 'baseInstructions', 'personality', 'approvalPolicy', 'sandbox', 'cwd', 'ephemeral', 'dynamicTools', 'config'],
    ThreadResumeParams: ['threadId', 'model', 'baseInstructions', 'personality', 'approvalPolicy', 'sandbox', 'cwd'],
    ThreadForkParams: ['threadId', 'ephemeral', 'excludeTurns', 'model', 'approvalPolicy', 'sandbox'],
    TurnStartParams: ['threadId', 'input', 'model', 'effort'],
    TurnInterruptParams: ['threadId', 'turnId'],
    DynamicToolCallParams: ['tool', 'arguments', 'callId'],
    DynamicToolCallResponse: ['contentItems', 'success'],
  } as Record<string, string[]>,
};

/** Model catalog fields Rein knows (it nulls the tool-related ones, see catalog.ts). */
const KNOWN_CATALOG_KEYS = new Set([
  'additional_speed_tiers', 'apply_patch_tool_type', 'availability_nux', 'available_access_programs', 'comp_hash', 'context_window', 'default_reasoning_level',
  'default_reasoning_summary', 'default_verbosity', 'description', 'display_name', 'effective_context_window_percent', 'experimental_supported_tools',
  'include_apps_usage_instructions', 'include_plugin_usage_instructions', 'include_skills_usage_instructions', 'input_modalities', 'max_context_window',
  'model_messages', 'multi_agent_reasoning_effort', 'multi_agent_version', 'node_repl_auto_review_required', 'node_repl_disabled', 'priority', 'service_tiers',
  'shell_type', 'slug', 'support_verbosity', 'supported_in_api', 'supported_reasoning_levels', 'supports_experimental_context', 'supports_image_detail_original',
  'supports_reasoning_effort_updates', 'supports_search_tool', 'tool_mode', 'truncation_policy', 'upgrade', 'use_responses_lite', 'visibility', 'web_search_tool_type',
]);
/** New catalog fields with names like these may add built-in tools Rein doesn't strip yet. */
const TOOLISH = /tool|shell|exec|patch|agent|repl|browser|computer|apps?_|plugin|search|image/;

export type CompatReport = {
  version: string;
  /** false: Codex is switched off. undefined: couldn't check (Codex stays on, with a warning). */
  ok: boolean | undefined;
  missing: string[];
  warnings: string[];
  checkedAt: number;
};

const cacheFile = () => path.join(paths.state(), 'codex-compat.json');
type Cache = {version?: string; report?: CompatReport; features?: string[]};

export async function codexVersion(): Promise<string | undefined> {
  try {
    const res = await run(codexBin(), ['--version'], {timeoutMs: 15_000});
    return res.stdout.trim().split(/\s+/).at(-1) || undefined;
  } catch {
    return undefined;
  }
}

/** Feature flags this `codex` knows (`codex features list`); undefined if it can't say. */
export async function listFeatures(): Promise<string[] | undefined> {
  try {
    const res = await run(codexBin(), ['features', 'list'], {timeoutMs: 15_000});
    if (res.code !== 0) return undefined;
    const names = res.stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n): n is string => !!n && /^[a-z0-9_]+$/.test(n));
    return names.length ? names : undefined;
  } catch {
    return undefined;
  }
}

/** Methods / notification names declared in one of the schema's message unions. */
function methodsIn(schema: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (o: any) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const m = o.properties?.method;
    if (m?.enum) m.enum.forEach((x: string) => out.add(x));
    if (typeof m?.const === 'string') out.add(m.const);
    Object.values(o).forEach(walk);
  };
  walk(schema);
  return out;
}

/** Compare a generated schema bundle (directory) against what Rein needs. */
export async function checkSchema(dir: string): Promise<string[]> {
  const load = async (f: string) => JSON.parse(await readFile(path.join(dir, f), 'utf8'));
  const missing: string[] = [];
  const requests = methodsIn(await load('ClientRequest.json'));
  const notifications = methodsIn(await load('ServerNotification.json'));
  const serverRequests = methodsIn(await load('ServerRequest.json'));
  for (const m of REQUIRED.requests) if (!requests.has(m)) missing.push(`request ${m}`);
  for (const m of REQUIRED.notifications) if (!notifications.has(m)) missing.push(`notification ${m}`);
  for (const m of REQUIRED.serverRequests) if (!serverRequests.has(m)) missing.push(`server request ${m}`);
  const defs: Record<string, any> = (await load('codex_app_server_protocol.v2.schemas.json')).definitions ?? {};
  for (const [type, fields] of Object.entries(REQUIRED.fields)) {
    // Some types only exist as their own file (e.g. the dynamic tool call messages).
    const def = defs[type] ?? (await load(`${type}.json`).catch(() => undefined));
    const props = def?.properties ?? {};
    if (!def) missing.push(`type ${type}`);
    else for (const f of fields) if (!(f in props)) missing.push(`${type}.${f}`);
  }
  return missing;
}

/** Tool-like model catalog fields Rein doesn't know about (it can't strip what it doesn't know). */
export function unknownToolFields(models: Record<string, unknown>[]): string[] {
  const keys = new Set(models.flatMap((m) => Object.keys(m)));
  return [...keys].filter((k) => !KNOWN_CATALOG_KEYS.has(k) && TOOLISH.test(k)).sort();
}

/** Run the full check for the installed `codex` (no cache). */
export async function checkCodex(version: string, catalogModels?: Record<string, unknown>[]): Promise<{report: CompatReport; features?: string[]}> {
  const report: CompatReport = {version, ok: undefined, missing: [], warnings: [], checkedAt: Date.now()};
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rein-codex-schema-'));
  try {
    const gen = await run(codexBin(), ['app-server', 'generate-json-schema', '--experimental', '--out', dir], {timeoutMs: 60_000});
    if (gen.code !== 0) report.warnings.push(`couldn't read the app-server schema (${gen.stderr.trim().split('\n')[0] || `exit ${gen.code}`})`);
    else {
      report.missing = await checkSchema(dir);
      report.ok = report.missing.length === 0;
    }
  } catch (err) {
    report.warnings.push(`couldn't read the app-server schema (${(err as Error).message})`);
  } finally {
    await rm(dir, {recursive: true, force: true}).catch(() => {});
  }
  const features = await listFeatures();
  if (catalogModels?.length) {
    const unknown = unknownToolFields(catalogModels);
    if (unknown.length) report.warnings.push(`new model catalog fields Rein doesn't strip yet: ${unknown.join(', ')} (Codex runs read-only and Rein declines its approval requests, so built-in tools still can't act)`);
  }
  return {report, features};
}

let memo: Promise<{report: CompatReport; features?: string[]} | undefined> | undefined;

/** The check for the installed `codex`, once per version (cached in ~/.rein/state/codex-compat.json). */
export function codexCompat(catalogModels?: () => Promise<Record<string, unknown>[] | undefined>): Promise<{report: CompatReport; features?: string[]} | undefined> {
  memo ??= (async () => {
    const version = await codexVersion();
    if (!version) return undefined;
    const cache = await readJson<Cache>(cacheFile(), {}).catch(() => ({}) as Cache);
    if (cache.version === version && cache.report) return {report: cache.report, features: cache.features};
    const result = await checkCodex(version, await catalogModels?.().catch(() => undefined));
    await writeJson(cacheFile(), {version, report: result.report, features: result.features}).catch(() => {});
    return result;
  })();
  return memo;
}

/** Forget the cached result (after `/update` installs a new codex). */
export function resetCodexCompat(): void {
  memo = undefined;
}

/** The user-facing explanation when Codex is switched off. */
export function incompatibleMessage(r: CompatReport): string {
  return `Codex ${r.version} changed its app-server protocol in ways this version of Rein doesn't support yet (missing: ${r.missing.slice(0, 6).join(', ')}${r.missing.length > 6 ? ', …' : ''}). Codex is switched off so chats don't break — Claude keeps working. Update Rein (/update), or go back to a supported Codex: npm install -g @openai/codex@${SUPPORTED_CODEX}.`;
}

/** The newest Codex line verified end to end (live chats, tools, /btw forks). */
export const SUPPORTED_CODEX = '0.160';
