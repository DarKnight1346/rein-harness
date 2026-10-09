import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {parse} from 'yaml';
import {globToRegExp} from './tools/fs.js';
import type {ModelRef} from './providers/types.js';

/**
 * Policy as code: `.rein/policy.yaml` in a project, `~/.rein/policy.yaml` for every project. Rules
 * over tools, the paths they touch and the commands they run, each with a reason the agent is told,
 * and which models may work here. Checked on every tool call, by the main agent and subagents, in
 * every approval mode: `deny` refuses, `ask` needs your yes even in bypass.
 *
 *   rules:
 *     - deny: shell
 *       command: "git push --force|rm -rf /"
 *       reason: No force pushes or wiping the disk
 *     - ask: [edit, write, delete]
 *       paths: ["migrations/**"]
 *       reason: Migrations need a human look
 *   models:
 *     allow: ["claude:*"]
 */
export type PolicyRule = {effect: 'deny' | 'ask'; tools: string[]; paths?: RegExp[]; globs: string[]; command?: RegExp; reason: string; source: string};
export type Policy = {rules: PolicyRule[]; allowModels?: RegExp[]; denyModels?: RegExp[]; modelNames: {allow?: string[]; deny: string[]}; errors: string[]};

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);
/** `claude:*`, `codex:gpt-6*`: a model glob. */
const modelGlob = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

export function parsePolicy(text: string, source: string): Policy {
  const out: Policy = {rules: [], modelNames: {deny: []}, errors: []};
  let doc: any;
  try {
    doc = parse(text) ?? {};
  } catch (err) {
    out.errors.push(`${source}: ${(err as Error).message.split('\n')[0]}`);
    return out;
  }
  for (const [i, r] of (Array.isArray(doc.rules) ? doc.rules : []).entries()) {
    const effect = r?.deny !== undefined ? 'deny' : r?.ask !== undefined ? 'ask' : undefined;
    if (!effect) {
      out.errors.push(`${source}: rules[${i}] needs deny: or ask: (with the tools it covers, or "*")`);
      continue;
    }
    let command: RegExp | undefined;
    try {
      command = r.command !== undefined ? new RegExp(String(r.command), 'i') : undefined;
    } catch {
      out.errors.push(`${source}: rules[${i}].command isn't a valid regular expression`);
      continue;
    }
    out.rules.push({effect, tools: list(r[effect]), paths: list(r.paths).map(globToRegExp), globs: list(r.paths), command, reason: String(r.reason ?? 'not allowed by policy'), source});
  }
  if (doc.models?.allow) {
    out.modelNames.allow = list(doc.models.allow);
    out.allowModels = out.modelNames.allow.map(modelGlob);
  }
  if (doc.models?.deny) {
    out.modelNames.deny = list(doc.models.deny);
    out.denyModels = out.modelNames.deny.map(modelGlob);
  }
  return out;
}

const cache = new Map<string, {mtime: number; policy: Policy}>();
function read(file: string, label: string): Policy | undefined {
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(file);
  if (hit?.mtime === mtime) return hit.policy;
  const policy = parsePolicy(readFileSync(file, 'utf8'), label);
  cache.set(file, {mtime, policy});
  return policy;
}

/** The policy in force in `root`: the user's (~/.rein/policy.yaml), then the project's, combined. */
export function loadPolicy(root: string, userDir: string): Policy {
  const parts = [read(path.join(userDir, 'policy.yaml'), '~/.rein/policy.yaml'), read(path.join(root, '.rein', 'policy.yaml'), '.rein/policy.yaml')].filter((p): p is Policy => !!p);
  return {
    rules: parts.flatMap((p) => p.rules),
    allowModels: parts.some((p) => p.allowModels) ? parts.flatMap((p) => p.allowModels ?? []) : undefined,
    denyModels: parts.flatMap((p) => p.denyModels ?? []),
    modelNames: {allow: parts.some((p) => p.modelNames.allow) ? parts.flatMap((p) => p.modelNames.allow ?? []) : undefined, deny: parts.flatMap((p) => p.modelNames.deny)},
    errors: parts.flatMap((p) => p.errors),
  };
}

/** The first rule a call matches: deny before ask. `files` are project-relative paths (posix). */
export function checkPolicy(p: Policy, tool: string, args: any, files: string[]): PolicyRule | undefined {
  const matches = p.rules.filter((r) => {
    if (!r.tools.includes('*') && !r.tools.includes(tool)) return false;
    if (r.paths?.length && !files.some((f) => r.paths!.some((re) => re.test(f)))) return false;
    if (r.command && !(tool === 'shell' && r.command.test(String(args?.command ?? '')))) return false;
    return true;
  });
  return matches.find((r) => r.effect === 'deny') ?? matches[0];
}

/** Why a model may not work here, or undefined when it may. */
export function modelBlocked(p: Policy, ref: ModelRef): string | undefined {
  const key = `${ref.provider}:${ref.model}`;
  if (p.denyModels?.some((re) => re.test(key))) return `${key} is denied by the policy (models.deny)`;
  if (p.allowModels && !p.allowModels.some((re) => re.test(key))) return `${key} isn't in the policy's models.allow`;
  return undefined;
}
