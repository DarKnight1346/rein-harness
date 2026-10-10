import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reinHome} from '../store/paths.js';
import {run} from '../util/proc.js';
import {DEFAULT_PORT} from './auth.js';

/**
 * `rein service --install [--port <n>]` / `--uninstall`: the web UI as a service that starts
 * with the system. macOS: a launchd agent; Linux: a systemd user unit; Windows: a scheduled task at
 * logon. It runs the Rein you installed it with, with your PATH (so it finds claude and codex),
 * and logs to ~/.rein/logs/webui.log.
 */
export type Exec = (cmd: string, args: string[]) => Promise<{code: number; stdout: string; stderr: string}>;
const exec: Exec = (cmd, args) => run(cmd, args, {timeoutMs: 60_000}).then((r) => ({...r, code: r.code ?? 1}), (err) => ({code: 1, stdout: '', stderr: (err as Error).message}));

export const LABEL = 'dev.rein.webui';
const UNIT = 'rein-webui.service';
const TASK = 'Rein Web UI';

type Paths = {plist: string; unit: string; log: string};
export const servicePaths = (home = os.homedir()): Paths => ({
  plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  unit: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'systemd', 'user', UNIT),
  log: path.join(reinHome(), 'logs', 'webui.log'),
});

/** How the service runs Rein: this Node, this Rein, the web UI on `port`. */
export function command(port: number): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1]!, '--ui', '--port', String(port)];
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function launchdPlist(cmd: string[], env: Record<string, string>, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${cmd.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);
export function systemdUnit(cmd: string[], env: Record<string, string>, log: string): string {
  return `[Unit]
Description=Rein web UI
After=network-online.target

[Service]
ExecStart=${cmd.map(quote).join(' ')}
${Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

/** The environment the service needs: PATH (claude, codex, git…) and where Rein keeps its files. */
function serviceEnv(): Record<string, string> {
  const env: Record<string, string> = {PATH: process.env.PATH ?? '', HOME: os.homedir()};
  for (const k of ['REIN_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

export async function installService(opts: {port?: number; exec?: Exec; home?: string; platform?: NodeJS.Platform} = {}): Promise<string[]> {
  const port = opts.port ?? DEFAULT_PORT;
  const x = opts.exec ?? exec;
  const platform = opts.platform ?? process.platform;
  const p = servicePaths(opts.home);
  mkdirSync(path.dirname(p.log), {recursive: true});
  const cmd = command(port);
  const out: string[] = [];
  if (platform === 'darwin') {
    mkdirSync(path.dirname(p.plist), {recursive: true});
    const domain = `gui/${os.userInfo().uid}`;
    await x('launchctl', ['bootout', `${domain}/${LABEL}`]); // an earlier install: replaced
    writeFileSync(p.plist, launchdPlist(cmd, serviceEnv(), p.log));
    const r = await x('launchctl', ['bootstrap', domain, p.plist]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`);
    out.push(`Installed the launchd agent ${p.plist}: the web UI starts when you log in, on port ${port}.`);
  } else if (platform === 'linux') {
    const has = await x('systemctl', ['--user', '--version']);
    if (has.code !== 0) throw new Error("this system has no systemd user session (systemctl --user), so Rein can't install a service here: run rein --ui from your own startup script instead");
    mkdirSync(path.dirname(p.unit), {recursive: true});
    writeFileSync(p.unit, systemdUnit(cmd, serviceEnv(), p.log));
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', UNIT], ['--user', 'restart', UNIT]]) {
      const r = await x('systemctl', args);
      if (r.code !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
    }
    out.push(`Installed the systemd user service ${p.unit}, on port ${port}.`, `To start it at boot without logging in: loginctl enable-linger ${os.userInfo().username}`);
  } else if (platform === 'win32') {
    const tr = cmd.map((a) => `"${a}"`).join(' ');
    const r = await x('schtasks', ['/Create', '/TN', TASK, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', tr]);
    if (r.code !== 0) throw new Error(`schtasks /Create failed: ${(r.stderr || r.stdout).trim()}`);
    await x('schtasks', ['/Run', '/TN', TASK]);
    out.push(`Installed the scheduled task "${TASK}": the web UI starts when you log in, on port ${port}.`);
  } else throw new Error(`Rein can't install a service on ${platform}: run rein --ui from your own startup script`);
  out.push(`Logs: ${p.log}`);
  return out;
}

export async function uninstallService(opts: {exec?: Exec; home?: string; platform?: NodeJS.Platform} = {}): Promise<string> {
  const x = opts.exec ?? exec;
  const platform = opts.platform ?? process.platform;
  const p = servicePaths(opts.home);
  if (platform === 'darwin') {
    if (!existsSync(p.plist)) return 'The web UI service isn\'t installed.';
    await x('launchctl', ['bootout', `gui/${os.userInfo().uid}/${LABEL}`]);
    rmSync(p.plist, {force: true});
    return `Removed the launchd agent ${p.plist}.`;
  }
  if (platform === 'linux') {
    if (!existsSync(p.unit)) return 'The web UI service isn\'t installed.';
    await x('systemctl', ['--user', 'disable', '--now', UNIT]);
    rmSync(p.unit, {force: true});
    await x('systemctl', ['--user', 'daemon-reload']);
    return `Removed the systemd user service ${p.unit}.`;
  }
  if (platform === 'win32') {
    await x('schtasks', ['/End', '/TN', TASK]);
    const r = await x('schtasks', ['/Delete', '/TN', TASK, '/F']);
    return r.code === 0 ? `Removed the scheduled task "${TASK}".` : "The web UI service isn't installed.";
  }
  throw new Error(`Rein has no service on ${platform}`);
}
