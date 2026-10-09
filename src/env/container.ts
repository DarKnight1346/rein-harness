import {randomBytes} from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {run} from '../util/proc.js';

/**
 * Container sandbox per task (sandbox `container`): the agent's commands run in a container of
 * their own for each conversation (Docker or Podman), with the project mounted at the same path.
 * Network: none at all, or — with an egress allowlist — an internal network whose only way out is a
 * small proxy container that lets through the listed hosts and nothing else. Torn down at the end.
 */
export type ContainerConfig = {image?: string; runtime?: 'docker' | 'podman'; egress?: string[]};
export type Exec = (cmd: string, args: string[]) => Promise<{code: number; stdout: string; stderr: string}>;
const defaultExec: Exec = async (cmd, args) => {
  const r = await run(cmd, args, {timeoutMs: 15 * 60_000}).catch((err) => ({code: 127, stdout: '', stderr: (err as Error).message}));
  return {code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr};
};

export const DEFAULT_IMAGE = 'node:22-bookworm';
const PROXY_PORT = 3128;

/**
 * The egress proxy, as plain JavaScript: the proxy container runs exactly this (`node -e`), and
 * egressProxy below is built from the same text, so what the tests check is what the container runs.
 * CONNECT (HTTPS) and plain HTTP, to allowed hosts only: exact names, or `*.example.com`.
 */
const PROXY_JS = `
function allowed(host, list) {
  const h = String(host).toLowerCase().replace(/\\.$/, '');
  return list.some((p) => {
    const q = String(p).toLowerCase().trim();
    return q.startsWith('*.') ? h === q.slice(2) || h.endsWith(q.slice(1)) : h === q;
  });
}
function egressProxy(http, net, list) {
  const server = http.createServer((req, res) => {
    let target;
    try { target = new URL(req.url || ''); } catch { res.writeHead(400).end('bad request\\n'); return; }
    if (!allowed(target.hostname, list)) {
      res.writeHead(403, {'content-type': 'text/plain'}).end('rein: ' + target.hostname + " isn't on this task's egress allowlist\\n");
      return;
    }
    const up = http.request(target, {method: req.method, headers: req.headers}, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on('connect', (req, socket, head) => {
    const [host, port] = String(req.url || '').split(':');
    if (!host || !allowed(host, list)) { socket.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\nrein: ' + host + " isn't on this task's egress allowlist\\r\\n"); return; }
    const up = net.connect(Number(port) || 443, host, () => { socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); up.write(head); up.pipe(socket); socket.pipe(up); });
    up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\\r\\n\\r\\n'));
    socket.on('error', () => up.destroy());
  });
  return server;
}
`;

const built = new Function(`${PROXY_JS}; return {allowed, egressProxy};`)() as {allowed(host: string, list: string[]): boolean; egressProxy(h: typeof http, n: typeof net, list: string[]): http.Server};

/** Is `host` allowed by the list? Exact names, or `*.example.com` for the subdomains (and the name itself). */
export const allowed = (host: string, list: string[]) => built.allowed(host, list);
export const egressProxy = (list: string[]) => built.egressProxy(http, net, list);

/** The program the proxy container runs. */
export function proxyProgram(list: string[]): string {
  return `const http=require('http'),net=require('net');${PROXY_JS};egressProxy(http,net,${JSON.stringify(list)}).listen(Number(process.env.REIN_PROXY_PORT)||${PROXY_PORT},'0.0.0.0');`;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export class ContainerBox {
  readonly id = randomBytes(4).toString('hex');
  private state: 'off' | 'starting' | 'ready' | 'unavailable' = 'off';
  private reason = '';
  private starting: Promise<void> | undefined;
  private runtime: string = 'docker';

  constructor(
    private readonly roots: () => string[],
    private readonly config: () => ContainerConfig,
    private readonly exec: Exec = defaultExec,
    private readonly log: (t: string) => void = () => {},
  ) {}

  private names() {
    return {task: `rein-task-${this.id}`, proxy: `rein-egress-${this.id}`, net: `rein-net-${this.id}`};
  }

  status(): {state: string; detail?: string} {
    return {state: this.state, ...(this.reason ? {detail: this.reason} : {})};
  }

  ready(): Promise<void> {
    if (this.state === 'ready' || this.state === 'unavailable') return Promise.resolve();
    return (this.starting ??= this.start().finally(() => (this.starting = undefined)));
  }

  private async start(): Promise<void> {
    this.state = 'starting';
    const cfg = this.config();
    const fail = (why: string) => {
      this.state = 'unavailable';
      this.reason = why;
      this.log(`Container sandbox: ${why}. Commands run with the OS sandbox instead.`);
    };
    for (const rt of cfg.runtime ? [cfg.runtime] : ['docker', 'podman']) {
      if ((await this.exec(rt, ['info', '--format', '{{.ServerVersion}}'])).code === 0) {
        this.runtime = rt;
        break;
      }
      if (rt === (cfg.runtime ?? 'podman')) return fail(cfg.runtime ? `${cfg.runtime} isn't running` : 'neither Docker nor Podman is running');
    }
    const n = this.names();
    const image = cfg.image || DEFAULT_IMAGE;
    const egress = (cfg.egress ?? []).filter(Boolean);
    const mounts = this.roots().flatMap((r) => ['-v', `${r}:${r}`]);
    const env: string[] = [];
    if (egress.length) {
      // An internal network has no way out; the proxy is on it and on the default network.
      if ((await this.exec(this.runtime, ['network', 'create', '--internal', n.net])).code !== 0) return fail('couldn’t create the task network');
      const proxy = await this.exec(this.runtime, ['run', '-d', '--rm', '--name', n.proxy, 'node:22-alpine', 'node', '-e', proxyProgram(egress)]);
      if (proxy.code !== 0) return fail(`couldn’t start the egress proxy: ${proxy.stderr.trim().split('\n').pop()}`);
      await this.exec(this.runtime, ['network', 'connect', n.net, n.proxy]);
      const url = `http://${n.proxy}:${PROXY_PORT}`;
      env.push('-e', `HTTP_PROXY=${url}`, '-e', `HTTPS_PROXY=${url}`, '-e', `http_proxy=${url}`, '-e', `https_proxy=${url}`, '-e', 'NO_PROXY=localhost,127.0.0.1');
    }
    this.log(`Container sandbox: starting ${image} (${egress.length ? `egress to ${egress.join(', ')} only` : 'no network'})…`);
    const task = await this.exec(this.runtime, ['run', '-d', '--rm', '--name', n.task, '--network', egress.length ? n.net : 'none', ...mounts, '-w', this.roots()[0] ?? '/', ...env, image, 'sleep', 'infinity']);
    if (task.code !== 0) return fail(`couldn’t start ${image}: ${task.stderr.trim().split('\n').pop()}`);
    this.state = 'ready';
    this.reason = `${this.runtime}, ${image}, ${egress.length ? `egress: ${egress.join(', ')}` : 'no network'}`;
  }

  /** The command line that runs `command` in the task's container, from `cwd`. Undefined: not ready, or cwd isn't mounted. */
  apply(command: string, cwd: string): {command: string; env?: Record<string, string>; container: true} | undefined {
    if (this.state !== 'ready') return undefined;
    if (!this.roots().some((r) => cwd === r || cwd.startsWith(r.endsWith('/') ? r : `${r}/`) || cwd.startsWith(`${r}\\`))) return undefined;
    return {command: `${this.runtime} exec -w ${quote(cwd)} ${this.names().task} sh -c ${quote(command)}`, container: true};
  }

  /** Remove the containers and the network (the end of the conversation, or Rein exiting). */
  async stop(): Promise<void> {
    if (this.state !== 'ready' && this.state !== 'starting') return;
    const n = this.names();
    await this.exec(this.runtime, ['rm', '-f', n.task, n.proxy]);
    await this.exec(this.runtime, ['network', 'rm', n.net]);
    this.state = 'off';
  }
}
