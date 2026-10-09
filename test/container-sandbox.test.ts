import {spawn} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import {allowed, ContainerBox, egressProxy, proxyProgram, type Exec} from '../src/env/container.js';

describe('container sandbox per task', () => {
  it('allows only listed hosts (exact, or *.domain)', () => {
    const list = ['registry.npmjs.org', '*.github.com'];
    expect(['registry.npmjs.org', 'api.github.com', 'github.com', 'REGISTRY.npmjs.org.'].map((h) => allowed(h, list))).toEqual([true, true, true, true]);
    expect(['evil.com', 'npmjs.org', 'github.com.evil.com'].map((h) => allowed(h, list))).toEqual([false, false, false]);
  });

  it('starts one container per task with no network, or behind the egress proxy, and runs commands in it', async () => {
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), {code: 0, stdout: '27.0', stderr: ''});
    const open = new ContainerBox(() => ['/work/shop'], () => ({image: 'node:22-bookworm'}), exec);
    await open.ready();
    expect(calls.at(-1)).toBe(`docker run -d --rm --name rein-task-${open.id} --network none -v /work/shop:/work/shop -w /work/shop node:22-bookworm sleep infinity`);
    expect(open.apply('npm test', '/work/shop/api')).toEqual({command: `docker exec -w '/work/shop/api' rein-task-${open.id} sh -c 'npm test'`, container: true});
    expect(open.apply('ls', '/elsewhere')).toBeUndefined(); // not mounted: on the host
    calls.length = 0;
    const net2 = new ContainerBox(() => ['/w'], () => ({egress: ['registry.npmjs.org']}), exec);
    await net2.ready();
    expect(calls.map((c) => c.split(' ').slice(0, 4).join(' '))).toEqual(['docker info --format {{.ServerVersion}}', 'docker network create --internal', 'docker run -d --rm', `docker network connect rein-net-${net2.id}`, 'docker run -d --rm']);
    expect(calls.at(-1)).toContain(`--network rein-net-${net2.id}`);
    expect(calls.at(-1)).toContain(`-e HTTPS_PROXY=http://rein-egress-${net2.id}:3128`);
    calls.length = 0;
    await net2.stop();
    expect(calls).toEqual([`docker rm -f rein-task-${net2.id} rein-egress-${net2.id}`, `docker network rm rein-net-${net2.id}`]);
  });

  it('falls back when no container runtime is running', async () => {
    const logs: string[] = [];
    const box = new ContainerBox(() => ['/w'], () => ({}), async () => ({code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon'}), (t) => logs.push(t));
    await box.ready();
    expect(box.apply('ls', '/w')).toBeUndefined();
    expect(logs).toEqual(['Container sandbox: neither Docker nor Podman is running. Commands run with the OS sandbox instead.']);
  });
});

describe('the egress proxy', () => {
  const servers: {close(): void}[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));
  const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)));

  it('forwards to allowed hosts and refuses the rest', async () => {
    const upstream = http.createServer((_q, res) => res.end('hello from upstream'));
    servers.push(upstream);
    const upPort = await listen(upstream);
    const proxy = egressProxy(['127.0.0.1']);
    servers.push(proxy);
    const port = await listen(proxy);
    const get = (url: string) => new Promise<{status: number; body: string}>((resolve) => http.get({host: '127.0.0.1', port, path: url}, (r) => {
      let body = '';
      r.on('data', (d) => (body += d));
      r.on('end', () => resolve({status: r.statusCode ?? 0, body}));
    }));
    expect(await get(`http://127.0.0.1:${upPort}/`)).toEqual({status: 200, body: 'hello from upstream'});
    expect((await get('http://example.com/')).status).toBe(403);
    const connect = (target: string) => new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      s.once('data', (d) => (resolve(d.toString().split('\r\n')[0]!), s.destroy()));
    });
    expect(await connect(`127.0.0.1:${upPort}`)).toBe('HTTP/1.1 200 Connection Established');
    expect(await connect('evil.com:443')).toBe('HTTP/1.1 403 Forbidden');
  });

  it('runs as the self-contained program the proxy container gets, and proxies', async () => {
    const upstream = http.createServer((_q, res) => res.end('ok'));
    servers.push(upstream);
    const upPort = await listen(upstream);
    const probe = net.createServer();
    const port = await new Promise<number>((r) => probe.listen(0, '127.0.0.1', () => r((probe.address() as net.AddressInfo).port)));
    probe.close();
    const child = spawn(process.execPath, ['-e', proxyProgram(['127.0.0.1'])], {env: {...process.env, REIN_PROXY_PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe']});
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const get = (url: string) => new Promise<number>((resolve) => {
      const req = http.get({host: '127.0.0.1', port, path: url}, (r) => (r.resume(), resolve(r.statusCode ?? 0)));
      req.on('error', () => resolve(-1));
    });
    let status = -1;
    for (let i = 0; i < 40 && status === -1; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = await get(`http://127.0.0.1:${upPort}/`);
    }
    expect([status, await get('http://example.com/'), err]).toEqual([200, 403, '']);
    child.kill();
  }, 20_000);
});
