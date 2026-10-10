import type {CommandName} from './index.js';

/**
 * Packs: specialist commands and built-in skills, off until you turn them on (/settings → Packs,
 * or `packs` in config.json). Most people never need a Java 21 migration playbook or a cross-repo
 * symbol graph, and ~85 entries made the `/` list hard to use. A pack that's off hides its
 * commands from the `/` list and /help and its skills from the agent; typing one of its commands
 * says which pack it's in.
 */
export type Pack = {id: string; label: string; description: string; commands: CommandName[]; skills: string[]};

export const PACKS: Pack[] = [
  {id: 'ci', label: 'CI and pull requests', description: 'CI checks and fixes, PRs, affected and flaky tests, coverage', commands: ['ci', 'pr', 'affected', 'flaky', 'build', 'coverage', 'mutate', 'trackers'], skills: []},
  {id: 'specs', label: 'Specs and planning', description: 'Specs, ADRs, architecture rules, plan risk, best-of-N runs', commands: ['spec', 'adr', 'arch', 'risk', 'bestof'], skills: []},
  {id: 'migrations', label: 'Contracts and migrations', description: 'API contracts, schema migrations, dead code, migration playbooks', commands: ['contracts', 'migrations', 'deadcode', 'flags'], skills: ['codemod', 'expand-contract', 'contract-tests', 'migrate:java21', 'migrate:python3', 'migrate:react-hooks']},
  {id: 'system', label: 'Multi-repo systems', description: 'Service and symbol graphs, impact across repos, local stacks', commands: ['services', 'symbols', 'refs', 'impact', 'changeset', 'codemap', 'stack'], skills: []},
  {id: 'codebase', label: 'Large codebases', description: 'Workspaces, monorepo scope, code owners, semantic index', commands: ['workspace', 'scope', 'owners', 'index', 'map', 'pack'], skills: []},
  {id: 'insight', label: 'Insight and automation', description: 'Stats, cache analytics, scheduled jobs, sessions, policy, tours', commands: ['stats', 'cache', 'schedule', 'env', 'sessions', 'policy'], skills: ['tour']},
];

let enabled: () => readonly string[] = () => [];
/** The runtime says which packs are on (config `packs`). */
export function setEnabledPacks(fn: () => readonly string[]): void {
  enabled = fn;
}

export const packOfCommand = (name: string) => PACKS.find((p) => p.commands.includes(name as CommandName));
export const packOfSkill = (name: string) => PACKS.find((p) => p.skills.includes(name));
const on = (p: Pack | undefined) => !p || enabled().includes(p.id);
export const commandEnabled = (name: string) => on(packOfCommand(name));
export const builtinSkillEnabled = (name: string) => on(packOfSkill(name));

/** The line under the command list in /help: which packs are off and where to turn them on. */
export function packsHint(): string {
  const off = PACKS.filter((p) => !on(p));
  if (!off.length) return 'Every pack is on (/settings → Packs).';
  return `${off.reduce((n, p) => n + p.commands.length + p.skills.length, 0)} more commands and skills are in packs that are off: ${off.map((p) => p.label).join(', ')}. Turn them on in /settings → Packs.`;
}

/** What typing a command of a pack that's off says. */
export function packOffMessage(name: string): string | undefined {
  const p = packOfCommand(name);
  if (!p || on(p)) return undefined;
  return `/${name} is in the ${p.label} pack, which is off. Turn it on in /settings → Packs (or add "${p.id}" to packs in config.json).`;
}
