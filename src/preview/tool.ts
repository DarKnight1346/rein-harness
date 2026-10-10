import type {ToolDef} from '../tools/registry.js';
import {startDisplay} from './display.js';
import {vncTarget, type Previews} from './registry.js';
import {remoteBinary, remoteWindows, startRemote, type RemoteStream} from './remote.js';

/**
 * `preview`: the agent shows the user something with a screen. A web app it started (a URL, local
 * or not: the browser runs on this machine, so localhost works as-is), or a display (VNC: a VM,
 * an emulator, a desktop app in a virtual display). Offered in web UI chats, where the user may be
 * on another device; servers that print a local URL are offered as previews without it.
 */
export function previewTool(previews: Previews, opened: (id: number) => void, reinRemote: () => string | undefined = () => 'auto'): ToolDef {
  return {
    name: 'preview',
    label: 'Preview',
    description:
      "Show the user something you made that has a screen, live in their Rein window (they may be on another device, so they can't open localhost themselves). For a web app, give its url (http://localhost:5173 works: the browser runs on this machine, so the app's calls to its own API work too); servers you start that print a local URL are offered automatically, so call this to open one for the user or to name it. For anything else with a screen, give a vnc address: a VM (qemu ... -vnc :1, then vnc ':1'), an Android emulator or a desktop app in a virtual display (Xvfb + x11vnc). The user can click and type into it.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {type: 'string', description: 'An http(s) URL to show, e.g. http://localhost:3000/dashboard'},
        vnc: {type: 'string', description: 'A VNC display: host:port, or :N for display N (port 5900+N)'},
        title: {type: 'string', description: 'A short name for it (default: the address)'},
        password: {type: 'string', description: "The VNC display's password, if it has one (the user is asked otherwise)"},
        window: {
          type: 'string',
          description:
            "Any app's window on this computer's screen, streamed with Rein Remote, with input (macOS, Windows, Linux; a desktop app, the iOS Simulator, the Android emulator, a game): part of its title or app's name, or its id. 'list' returns the windows to choose from",
        },
        app: {type: 'boolean', description: 'Linux: start a virtual display for a native (GUI) app, no VM needed. Rein starts the display and shows it; you then start the app on it with your shell tool (DISPLAY=:N your-app &)'},
      },
    },
    mutating: false,
    summarize: (a) => String(a?.title || a?.url || a?.vnc || ''),
    async run(_ctx, args) {
      const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 60) : undefined;
      if (typeof args?.url === 'string' && args.url.trim()) {
        let u: URL;
        try {
          u = new URL(args.url.trim());
        } catch {
          return {ok: false, text: `Not a URL: ${args.url}`};
        }
        if (!/^https?:$/.test(u.protocol)) return {ok: false, text: 'Only http(s) URLs can be previewed.'};
        if (u.hostname === '0.0.0.0') u.hostname = 'localhost';
        const p = previews.add({kind: 'url', target: u.toString(), title: title ?? u.host, source: 'agent'});
        opened(p.id);
        return {ok: true, text: `Showing ${u} to the user (preview #${p.id}). They can click and type into it; it updates as the page changes.`};
      }
      if (typeof args?.window === 'string' && args.window.trim()) {
        const bin = remoteBinary(reinRemote());
        if (!bin) return {ok: false, text: "Showing a window needs Rein Remote (rein-remote in ~/.rein/bin or on PATH, from github.com/rein-harness/rein-remote), and the reinRemote setting isn't off."};
        try {
          const list = await remoteWindows(bin);
          const want = args.window.trim();
          if (want === 'list') return {ok: true, text: list.length ? `Windows on screen:\n${list.map((w) => `  ${w.id}  ${w.app}${w.title ? ` — ${w.title}` : ''}  (${w.width}×${w.height})`).join('\n')}\nShow one with window: its id.` : 'No windows on screen.'};
          const q = want.toLowerCase();
          const found = list.find((w) => String(w.id) === want) ?? list.find((w) => w.title.toLowerCase().includes(q) || w.app.toLowerCase().includes(q));
          if (!found) return {ok: false, text: `No window matches "${want}". Windows on screen: ${list.map((w) => `${w.id} ${w.app}${w.title ? ` — ${w.title}` : ''}`).join('; ') || 'none'}.`};
          const remote = await startRemote(bin, {window: String(found.id)});
          const name = found.title || found.app;
          const p = previews.add({kind: 'window', target: String(found.id), title: title ?? name.slice(0, 60), source: 'agent', stop: remote.stop, remote: {port: remote.port, token: remote.token}});
          opened(p.id);
          return {ok: true, text: `Showing ${found.app}'s window "${name}" to the user (preview #${p.id}), streamed with Rein Remote; they can click and type into it. It stops when the preview closes.`};
        } catch (err) {
          return {ok: false, text: `Couldn't show the window: ${(err as Error).message}`};
        }
      }
      if (args?.app === true) {
        // A virtual display for a native app: Rein starts the display (no project code runs); the agent
        // starts the app on it with its shell tool, so the user's approvals apply to that as always.
        try {
          // Streamed with Rein Remote when it's installed (video, smooth on slow links), else over VNC.
          const bin = remoteBinary(reinRemote());
          const d = await startDisplay({width: 1280, height: 800}, !!bin);
          let remote: RemoteStream | undefined;
          if (bin) remote = await startRemote(bin, d.display).catch(() => undefined);
          if (!remote && d.port === undefined) {
            d.stop();
            return {ok: false, text: "Couldn't start a virtual display: Rein Remote didn't start and there's no VNC server to fall back on (install x11vnc, or TigerVNC)"};
          }
          const stop = () => (remote?.stop(), d.stop());
          const p = previews.add({kind: 'vnc', target: d.port !== undefined ? `localhost:${d.port}` : `:${d.display}`, title: title ?? `display :${d.display}`, source: 'agent', stop, ...(remote ? {remote: {port: remote.port, token: remote.token}} : {})});
          opened(p.id);
          return {ok: true, text: `A virtual display is up (${d.how}${remote ? ', streamed with Rein Remote' : ''}, :${d.display}, 1280×800) and the user is looking at it (preview #${p.id}). Start the app on it in the background with your shell tool: DISPLAY=:${d.display} <command> &. It stops when the preview closes.`};
        } catch (err) {
          return {ok: false, text: `Couldn't start a virtual display: ${(err as Error).message}`};
        }
      }
      if (typeof args?.vnc === 'string' && args.vnc.trim()) {
        const target = vncTarget(args.vnc);
        if (!target) return {ok: false, text: `Not a VNC address: ${args.vnc} (use host:port or :N)`};
        const p = previews.add({kind: 'vnc', target, title: title ?? target, source: 'agent', ...(typeof args?.password === 'string' && args.password ? {password: args.password} : {})});
        opened(p.id);
        return {ok: true, text: `Showing the display at ${target} to the user (preview #${p.id}).`};
      }
      const known = previews.list();
      return {ok: false, text: `Give a url, a vnc address or a window.${known.length ? ` Previews now: ${known.map((p) => `#${p.id} ${p.target}`).join(', ')}.` : ''}`};
    },
  };
}
