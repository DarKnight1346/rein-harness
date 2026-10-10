import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import net from 'node:net';
import {onPath} from '../lsp/servers.js';

/**
 * A virtual display for a native app on Linux, with no VM and no real screen (a headless server
 * works): TigerVNC's Xvnc, which is a display and a VNC server in one, or Xvfb with x11vnc. The app
 * is started on it (DISPLAY=:N) by the agent's own shell command, so approvals apply as usual; Rein
 * shows the display as a VNC preview. macOS and Windows have no virtual displays like this: there
 * an app's window is captured instead (window.ts).
 */
export type VirtualDisplay = {display: number; /** Its VNC port (none: Xvfb alone, streamed by Rein Remote). */ port?: number; how: string; stop(): void};

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });

/** What this machine can run a virtual display with, or what to install. `remote`: Rein Remote is
 * there to stream it, so Xvfb alone will do (no VNC server needed). */
export function displayTools(remote = false): {xvnc?: string; xvfb?: string; x11vnc?: string; missing?: string} {
  if (process.platform !== 'linux') return {missing: 'virtual displays are a Linux feature: on macOS and Windows, preview the app’s window instead (window: "<app name>")'};
  const xvnc = onPath('Xvnc') ?? onPath('Xtigervnc');
  const xvfb = onPath('Xvfb');
  const x11vnc = onPath('x11vnc');
  if (xvnc || (xvfb && (x11vnc || remote))) return {...(xvnc ? {xvnc} : {}), ...(xvfb ? {xvfb} : {}), ...(x11vnc ? {x11vnc} : {})};
  return {missing: 'no virtual display found: install TigerVNC (apt install tigervnc-standalone-server, dnf install tigervnc-server) or Xvfb and x11vnc'};
}

/** Start a display (the first free :N from :20) at `width`×`height`, its VNC (when there is one) on
 * localhost only. `remote`: Rein Remote will stream it, so a VNC server is optional. */
export async function startDisplay(size: {width: number; height: number}, remote = false): Promise<VirtualDisplay> {
  const tools = displayTools(remote);
  if (tools.missing) throw new Error(tools.missing);
  let display = 20;
  while (display < 100 && (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`) || !(await free(5900 + display)))) display++;
  if (display >= 100) throw new Error('no free display number');
  const port = 5900 + display;
  const geometry = `${Math.max(640, Math.round(size.width))}x${Math.max(480, Math.round(size.height))}`;
  const procs: ChildProcess[] = [];
  const stop = () => procs.forEach((p) => p.kill());
  let how: string;
  if (tools.xvnc) {
    how = 'Xvnc';
    procs.push(spawn(tools.xvnc, [`:${display}`, '-geometry', geometry, '-depth', '24', '-SecurityTypes', 'None', '-localhost', '-rfbport', String(port), '-AlwaysShared', '-desktop', 'Rein preview'], {stdio: 'ignore'}));
  } else {
    how = tools.x11vnc ? 'Xvfb + x11vnc' : 'Xvfb';
    procs.push(spawn(tools.xvfb!, [`:${display}`, '-screen', '0', `${geometry}x24`, '-nolisten', 'tcp'], {stdio: 'ignore'}));
    const ready = await waitFor(() => existsSync(`/tmp/.X11-unix/X${display}`), 5000);
    if (!tools.x11vnc) {
      for (const p of procs) p.on('error', () => {});
      if (!ready) {
        stop();
        throw new Error("the virtual display (Xvfb) didn't start");
      }
      return {display, how, stop};
    }
    procs.push(spawn(tools.x11vnc, ['-display', `:${display}`, '-rfbport', String(port), '-localhost', '-nopw', '-forever', '-shared', '-quiet'], {stdio: 'ignore'}));
  }
  for (const p of procs) p.on('error', () => {});
  // Ready when its VNC port answers.
  const up = await waitFor(async () => !(await free(port)), 10_000);
  if (!up) {
    stop();
    throw new Error(`the virtual display (${how}) didn't start`);
  }
  return {display, port, how, stop};
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
