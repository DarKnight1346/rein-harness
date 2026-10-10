import type {ToolDef} from '../tools/registry.js';
import {vncTarget, type Previews} from './registry.js';

/**
 * `preview`: the agent shows the user something with a screen. A web app it started (a URL, local
 * or not: the browser runs on this machine, so localhost works as-is), or a display (VNC: a VM,
 * an emulator, a desktop app in a virtual display). Offered in web UI chats, where the user may be
 * on another device; servers that print a local URL are offered as previews without it.
 */
export function previewTool(previews: Previews, opened: (id: number) => void): ToolDef {
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
      if (typeof args?.vnc === 'string' && args.vnc.trim()) {
        const target = vncTarget(args.vnc);
        if (!target) return {ok: false, text: `Not a VNC address: ${args.vnc} (use host:port or :N)`};
        const p = previews.add({kind: 'vnc', target, title: title ?? target, source: 'agent'});
        opened(p.id);
        return {ok: true, text: `Showing the display at ${target} to the user (preview #${p.id}).`};
      }
      const known = previews.list();
      return {ok: false, text: `Give a url or a vnc address.${known.length ? ` Previews now: ${known.map((p) => `#${p.id} ${p.target}`).join(', ')}.` : ''}`};
    },
  };
}
