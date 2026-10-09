import {existsSync, statSync} from 'node:fs';
import path from 'node:path';
import {ownersOf} from '../context/owners.js';
import {findWorkspace} from '../workspace/index.js';

/**
 * Plan risk: what a plan touches, from the files it names — how many, across how many services
 * and owners, and whether contracts (API schemas, protobufs, GraphQL) or migrations are among them.
 * Shown with the plan before you approve it, and by /risk for a saved plan or spec.
 */
export type Risk = {level: 'low' | 'medium' | 'high'; score: number; files: string[]; services: string[]; owners: string[]; contracts: string[]; migrations: string[]; repos: string[]};

const CONTRACT = /(?:^|\/)(?:openapi|swagger|asyncapi)[^/]*\.(?:ya?ml|json)$|\.(?:proto|graphql|gql|avsc|thrift)$|(?:^|\/)schema\.(?:graphql|json|prisma)$|\.prisma$/i;
const MIGRATION = /(?:^|\/)(?:migrations?|migrate|alembic|db\/migrate|flyway)\//i;
const SERVICE_ROOTS = new Set(['services', 'apps', 'packages', 'libs', 'cmd', 'modules', 'crates']);

/** Paths a plan names that exist in the project (or a workspace repo), project-relative. */
export function plannedFiles(root: string, text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"(\[])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\/?)(?=[\s`'"),:;\]]|$)/gm)) {
    const p = m[1]!.replace(/[.,]+$/, '').replace(/^\.\//, '');
    if (!p.includes('/') && !/\.\w{1,6}$/.test(p)) continue; // a bare word, not a path
    const abs = path.resolve(root, p);
    if (!existsSync(abs)) continue;
    found.add(path.relative(root, abs).split(path.sep).join('/') + (statSync(abs).isDirectory() ? '/' : ''));
  }
  return [...found].filter((f) => f && !f.startsWith('.rein/'));
}

/** The service a path belongs to: services/payments/x.ts → services/payments; else its top folder. */
function serviceOf(rel: string): string {
  const parts = rel.replace(/\/$/, '').split('/');
  if (parts[0] === '..' && parts.length > 1) return parts.slice(0, 2).join('/'); // another workspace repo
  if (SERVICE_ROOTS.has(parts[0]!) && parts.length > 2) return parts.slice(0, 2).join('/');
  return parts.length > 1 ? parts[0]! : '.';
}

export async function planRisk(root: string, text: string): Promise<Risk> {
  const files = plannedFiles(root, text);
  const services = [...new Set(files.map(serviceOf))].filter((s) => s !== '.');
  const owners = [...new Set((await ownersOf(root, files.filter((f) => !f.startsWith('../')).map((f) => f.replace(/\/$/, ''))).catch(() => [])).flatMap((o) => (o.source === 'git history' ? [] : o.owners)))];
  const contracts = files.filter((f) => CONTRACT.test(f));
  const migrations = files.filter((f) => MIGRATION.test(f));
  const ws = findWorkspace(root);
  const repos = ws ? ws.repos.filter((r) => files.some((f) => path.resolve(root, f).startsWith(r.path + path.sep) || path.resolve(root, f) === r.path)).map((r) => r.name) : [];
  const score = Math.min(files.length, 20) + Math.max(0, services.length - 1) * 3 + Math.max(0, owners.length - 1) * 2 + contracts.length * 4 + migrations.length * 4 + Math.max(0, repos.length - 1) * 4;
  return {level: score >= 20 ? 'high' : score >= 8 ? 'medium' : 'low', score, files, services, owners, contracts, migrations, repos};
}

export function formatRisk(r: Risk): string {
  if (!r.files.length) return 'Risk: unknown (the plan names no files in this project).';
  const n = (x: number, w: string) => `${x} ${w}${x === 1 ? '' : 's'}`;
  const facts = [n(r.files.length, 'file'), r.services.length > 1 && n(r.services.length, 'service'), r.repos.length > 1 && n(r.repos.length, 'repo'), r.owners.length > 1 && n(r.owners.length, 'owner')].filter(Boolean).join(', ');
  return [
    `Risk: ${r.level} (${facts})`,
    ...(r.contracts.length ? [`  contracts: ${r.contracts.join(', ')}`] : []),
    ...(r.migrations.length ? [`  migrations: ${r.migrations.join(', ')}`] : []),
    ...(r.owners.length ? [`  owners: ${r.owners.join(', ')}`] : []),
    ...(r.services.length > 1 ? [`  services: ${r.services.join(', ')}`] : []),
  ].join('\n');
}
