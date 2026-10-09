import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {run} from '../util/proc.js';
import type {Service} from '../system/services.js';

/**
 * Multi-service local stack (/stack, the stack tool): bring up the services a change needs with
 * Docker Compose (their depends_on come along), wait for their health checks, and say where each
 * one listens, so the change is tested against the real neighbours. Helm charts only into a local
 * cluster (kind, minikube, Docker Desktop, k3d…), never a shared one.
 */
export type Exec = (cmd: string, args: string[], cwd: string, timeoutMs?: number) => Promise<{code: number; stdout: string; stderr: string}>;
const defaultExec: Exec = async (cmd, args, cwd, timeoutMs = 15 * 60_000) => {
  const r = await run(cmd, args, {cwd, timeoutMs}).catch((err) => ({code: 127, stdout: '', stderr: (err as Error).message}));
  return {code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr};
};

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
export const composeFile = (root: string) => COMPOSE_FILES.map((f) => path.join(root, f)).find((f) => existsSync(f));

export type ServiceState = {name: string; state: string; health?: string; ports: string[]};

/** Compose services built from (or named after) the given folders: the ones a change in them needs. */
export function composeServicesFor(file: string, dirs: string[]): string[] {
  let doc: any;
  try {
    doc = parseYaml(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const base = path.dirname(file);
  const out: string[] = [];
  for (const [name, def] of Object.entries<any>(doc?.services ?? {})) {
    const ctx = typeof def?.build === 'string' ? def.build : def?.build?.context;
    const at = ctx ? path.resolve(base, ctx) : undefined;
    if (dirs.some((d) => (at && (at === d || d.startsWith(at + path.sep) || at.startsWith(d + path.sep))) || path.basename(d).toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** `docker compose ps --format json`: one JSON object per line (newer) or an array (older). */
export function parsePs(stdout: string): ServiceState[] {
  const rows: any[] = [];
  const t = stdout.trim();
  if (t.startsWith('[')) {
    try {
      rows.push(...JSON.parse(t));
    } catch {}
  } else
    for (const l of t.split('\n'))
      try {
        if (l.trim()) rows.push(JSON.parse(l));
      } catch {}
  return rows.map((r) => ({
    name: r.Service ?? r.Name,
    state: String(r.State ?? '').toLowerCase(),
    ...(r.Health ? {health: String(r.Health).toLowerCase()} : {}),
    ports: (r.Publishers ?? []).filter((p: any) => p.PublishedPort).map((p: any) => `localhost:${p.PublishedPort} → ${p.TargetPort}/${p.Protocol ?? 'tcp'}`),
  }));
}

const ready = (s: ServiceState) => s.state === 'running' && (!s.health || s.health === 'healthy');

export class LocalStack {
  constructor(private readonly root: string, private readonly exec: Exec = defaultExec, private readonly wait = (ms: number) => new Promise((r) => setTimeout(r, ms))) {}

  private file(): string | undefined {
    return composeFile(this.root);
  }

  async status(): Promise<ServiceState[]> {
    const f = this.file();
    if (!f) return [];
    const r = await this.exec('docker', ['compose', '-f', f, 'ps', '--all', '--format', 'json'], this.root, 60_000);
    return r.code === 0 ? parsePs(r.stdout) : [];
  }

  /** Up: the named services (with their depends_on), then wait until each is running and healthy. */
  async up(names: string[], timeoutMs = 5 * 60_000): Promise<{ok: boolean; services: ServiceState[]; message: string}> {
    const f = this.file();
    if (!f) return {ok: false, services: [], message: 'No compose file here (compose.yaml or docker-compose.yml).'};
    if ((await this.exec('docker', ['compose', 'version'], this.root, 30_000)).code !== 0) return {ok: false, services: [], message: "Docker Compose isn't available (is Docker running?)."};
    const up = await this.exec('docker', ['compose', '-f', f, 'up', '-d', '--wait', '--wait-timeout', String(Math.round(timeoutMs / 1000)), ...names], this.root, timeoutMs + 60_000);
    let services = await this.status();
    // --wait already waited for health checks; older Compose without it: poll.
    for (let t = 0; up.code !== 0 && /unknown flag|--wait/.test(up.stderr) && t < timeoutMs; t += 2000) {
      if (t === 0) await this.exec('docker', ['compose', '-f', f, 'up', '-d', ...names], this.root, timeoutMs);
      services = await this.status();
      if (services.length && services.every(ready)) break;
      await this.wait(2000);
    }
    // Everything Compose started, the depends_on included, has to be ready.
    const wanted = services;
    const bad = wanted.filter((s) => !ready(s));
    if (bad.length) return {ok: false, services, message: `Not ready: ${bad.map((s) => `${s.name} (${s.health ?? s.state})`).join(', ')}.${up.stderr.trim() ? ` ${up.stderr.trim().split('\n').pop()}` : ''}`};
    return {ok: true, services, message: `Up and healthy: ${wanted.map((s) => s.name).join(', ')}.`};
  }

  async logs(name: string, lines = 80): Promise<string> {
    const f = this.file();
    if (!f) return 'No compose file here.';
    const r = await this.exec('docker', ['compose', '-f', f, 'logs', '--no-color', '--tail', String(lines), name], this.root, 60_000);
    return (r.stdout || r.stderr).trim() || '(no output)';
  }

  async down(): Promise<string> {
    const f = this.file();
    if (!f) return 'No compose file here.';
    const r = await this.exec('docker', ['compose', '-f', f, 'down'], this.root, 5 * 60_000);
    return r.code === 0 ? 'Stopped the stack.' : `docker compose down failed: ${r.stderr.trim().split('\n').pop()}`;
  }

  /** Helm: only into a local cluster. */
  async helm(chartDir: string): Promise<string> {
    const ctx = (await this.exec('kubectl', ['config', 'current-context'], this.root, 20_000)).stdout.trim();
    if (!ctx) return "kubectl has no current context (or isn't installed).";
    if (!/^(?:kind-|k3d-|minikube$|docker-desktop$|rancher-desktop$|orbstack$|colima)/.test(ctx)) return `Refusing to install into ${ctx}: /stack up --helm only deploys to a local cluster (kind, k3d, minikube, Docker Desktop, Rancher Desktop, OrbStack, Colima).`;
    const name = `rein-${path.basename(chartDir).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
    const r = await this.exec('helm', ['upgrade', '--install', name, chartDir, '--wait', '--timeout', '10m'], this.root, 11 * 60_000);
    return r.code === 0 ? `Installed ${name} into ${ctx}.` : `helm failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`;
  }
}

/** The compose services a branch's changes need, from which service folders it touches. */
export async function servicesForChange(root: string, services: Service[], exec: Exec = defaultExec): Promise<string[]> {
  const f = composeFile(root);
  if (!f) return [];
  const changed = (await exec('git', ['diff', '--name-only', 'HEAD'], root, 30_000)).stdout.split('\n').filter(Boolean).map((x) => path.join(root, x));
  const dirs = services.map((s) => s.dir).filter((d) => changed.some((c) => c.startsWith(d + path.sep)));
  return composeServicesFor(f, dirs);
}

export function formatServices(services: ServiceState[]): string {
  if (!services.length) return 'Nothing is running.';
  return services.map((s) => `  ${ready(s) ? '✓' : '·'} ${s.name}  ${s.state}${s.health ? ` (${s.health})` : ''}${s.ports.length ? `  ${s.ports.join(', ')}` : ''}`).join('\n');
}

/** `stack` (experiment stack-tool): the agent brings up, checks, reads logs of and stops the local stack. */
export function stackTool(experiments: () => string[], stack: () => LocalStack, change: () => Promise<string[]>): import('../tools/registry.js').ToolDef {
  return {
    name: 'stack',
    label: 'Stack',
    description: '',
    describe: () =>
      "Run the services this change needs locally, with Docker Compose, and test against them. action up (services, or omit for the ones your changes touch, with what they depend on: waits until healthy and lists their ports), status, logs (a service's recent output), or down. Ask the user before down if they started the stack themselves.",
    inputSchema: {type: 'object', properties: {action: {type: 'string', enum: ['up', 'status', 'logs', 'down']}, services: {type: 'array', items: {type: 'string'}}, service: {type: 'string', description: 'For logs'}}, required: ['action']},
    mutating: true,
    enabled: () => experiments().includes('stack-tool'),
    summarize: (a) => `${a?.action ?? ''} ${(a?.services ?? []).join(' ')}${a?.service ?? ''}`.trim(),
    async run(_ctx, args) {
      const s = stack();
      if (args?.action === 'status') return {ok: true, text: formatServices(await s.status())};
      if (args?.action === 'logs') return {ok: true, text: await s.logs(String(args?.service ?? ''))};
      if (args?.action === 'down') return {ok: true, text: await s.down()};
      const names = Array.isArray(args?.services) && args.services.length ? args.services.map(String) : await change();
      const r = await s.up(names);
      return {ok: r.ok, text: `${r.message}\n${formatServices(r.services)}`};
    },
  };
}
