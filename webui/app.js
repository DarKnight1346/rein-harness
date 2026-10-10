// Rein web UI: chats in your projects, and a file manager, in the browser. Plain modules, no build.
import {marked} from '/vendor/marked.js';

// ---------- small helpers ----------

/** Build an element: h('div.cls#id', {attrs, on: {click}}, ...children). Text children are text, never HTML. */
function h(tag, props, ...kids) {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || 'div');
  for (const r of rest) r[0] === '.' ? el.classList.add(r.slice(1)) : (el.id = r.slice(1));
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) kids.unshift(props), (props = null);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

const ICONS = {
  plus: 'M12 5v14M5 12h14', send: 'M5 12h14M13 5l7 7-7 7', stop: 'M7 7h10v10H7z', folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', file: 'M6 3h8l4 4v14H6zM14 3v4h4', chat: 'M4 5h16v11H8l-4 4z', gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4', restore: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5', back: 'M19 12H5M11 5l-7 7 7 7', forward: 'M5 12h14M13 5l7 7-7 7', home: 'M3 11l9-7 9 7v9H5v-9', drive: 'M3 15h18v5H3zM6 17.5h.01M3 15l3-10h12l3 10',
  menu: 'M4 6h16M4 12h16M4 18h16', panel: 'M4 5h16v14H4zM15 5v14', up: 'M12 19V5M5 12l7-7 7 7', upload: 'M12 16V4M6 10l6-6 6 6M4 20h16', refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5', more: 'M5 12h.01M12 12h.01M19 12h.01', x: 'M6 6l12 12M18 6L6 18', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', download: 'M12 4v12M6 10l6 6 6-6M4 20h16', newfolder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6',
};
const icon = (name, size = 18) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
};

// Markdown from the model: raw HTML is shown as text, links only to http(s), mail and relative places.
marked.use({
  gfm: true,
  renderer: {
    html: (t) => esc(t.raw ?? t.text ?? ''),
    link({href, title, tokens}) {
      const text = this.parser.parseInline(tokens);
      return /^(https?:|mailto:|#|\/(?!\/))/i.test(href ?? '') ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${text}</a>` : text;
    },
    image: ({href, text}) => `<a href="${/^https?:/i.test(href ?? '') ? esc(href) : '#'}" target="_blank" rel="noopener noreferrer">${esc(text || href || 'image')}</a>`,
  },
});
const md = (text) => {
  const el = h('div.md');
  el.innerHTML = marked.parse(text ?? '');
  return el;
};

const toasts = h('div.toasts');
function toast(text, kind) {
  const t = h('div.toast' + (kind === 'error' ? '.error' : ''), text);
  toasts.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

/** Only Rein's own API: a chat id or path from the address bar can't send a request anywhere else. */
const API_PATH = /^\/api\/[\w\/.~%!*'()-]*(\?[\w=&%.~+!*'()-]*)?$/;
async function api(path, opts = {}) {
  if (!API_PATH.test(path) || path.includes('..')) throw new Error(`not a Rein API path: ${path}`);
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {'X-Rein': '1', ...(opts.raw ? {} : {'content-type': 'application/json'})},
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.quiet) {
    state.me = undefined;
    render();
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
};
const base = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const sep = () => (state.platform === 'win32' ? '\\' : '/');
const join = (dir, name) => (dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep() + name);
/** A one-off chat's own folder (no project): don't show its name as if it were one. */
const isOneOff = (p) => !!state.oneOffRoot && !!p && p.startsWith(state.oneOffRoot);
const tilde = (p) => (state.home && p.startsWith(state.home) ? '~' + p.slice(state.home.length) : p);

// ---------- state ----------

const state = {
  booted: false,
  setup: false,
  mode: undefined,
  me: undefined,
  home: '',
  platform: '',
  version: '',
  projects: [],
  project: localStorage.getItem('rein.project') ?? '',
  chats: {open: [], saved: []},
  view: 'chat', // chat | files | settings
  chat: undefined, // {id, snapshot, live, tools, asks, busy, notes, es}
  files: {path: '', hidden: false, entries: [], sel: new Set(), sort: 'name', dir: 1, preview: undefined, search: '', results: undefined},
  sideOpen: false,
};

// ---------- boot, setup and sign-in ----------

async function boot() {
  document.body.append(toasts);
  applyTheme();
  try {
    const s = await api('/api/state', {quiet: true});
    Object.assign(state, {setup: s.setup, mode: s.mode, me: s.user, home: s.home, platform: s.platform, version: s.version, oneOffRoot: s.oneOffRoot});
  } catch (err) {
    document.getElementById('app').replaceChildren(h('div.center', h('div.card', h('h1', "Can't reach Rein"), h('p.lead', String(err.message)))));
    return;
  }
  state.booted = true;
  if (state.me) await afterSignIn();
  route();
  render();
}

function applyTheme() {
  const t = localStorage.getItem('rein.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function afterSignIn() {
  await loadSidebar();
  if (!state.project && state.projects[0]) state.project = state.projects[0].path;
}

function setupView() {
  const code = new URLSearchParams(location.search).get('setup') ?? '';
  const s = {step: 0, mode: 'local', code, username: '', password: '', password2: '', serve: true, error: ''};
  const root = h('div.center');
  const draw = () => {
    const card = h('div.card');
    if (s.step === 0) {
      card.append(
        h('h1', 'Welcome to Rein'),
        h('p.lead', "Let's set up the web UI. You can control Rein from any of your devices: chats in your projects, approvals, and a file manager for this machine."),
        h('label.field', 'Setup code'),
        h('input', {type: 'text', value: s.code, placeholder: 'printed where rein --ui started', on: {input: (e) => (s.code = e.target.value.trim())}}),
        h('p.muted', {style: {fontSize: '13px'}}, 'It proves you started Rein. Also in ~/.rein/webui-setup-code on this machine.'),
        h('div.actions', {style: {display: 'flex', justifyContent: 'flex-end', marginTop: '16px'}}, h('button.btn.primary', {on: {click: () => (s.code ? ((s.step = 1), draw()) : ((s.error = 'Enter the setup code.'), draw()))}}, 'Continue')),
      );
    } else if (s.step === 1) {
      const choice = (id, title, text) => h('button.choice' + (s.mode === id ? '.on' : ''), {type: 'button', on: {click: () => ((s.mode = id), draw())}}, h('input', {type: 'radio', checked: s.mode === id, tabIndex: -1}), h('div', h('b', title), h('small', text)));
      card.append(
        h('h1', 'How will you reach it?'),
        h('p.lead', 'You can change this later by deleting ~/.rein/webui.json and running setup again.'),
        h('div.choices',
          choice('local', 'Only this computer', 'No login. Rein listens on localhost only, so nothing else can reach it.'),
          choice('tailscale', 'My devices, through Tailscale', 'No login. Still on localhost; your phone and laptops reach it over your private tailnet (tailscale serve).'),
          choice('password', 'With a username and password', 'For your own server: Rein listens on the network and asks everyone to sign in. Put HTTPS in front of it (a reverse proxy, or tls in webui.json).'),
        ),
        s.mode === 'password' ? h('div', h('label.field', 'Username'), h('input', {type: 'text', value: s.username, autocomplete: 'username', on: {input: (e) => (s.username = e.target.value)}}), h('label.field', 'Password (10 characters or more)'), h('input', {type: 'password', value: s.password, autocomplete: 'new-password', on: {input: (e) => (s.password = e.target.value)}}), h('label.field', 'Password again'), h('input', {type: 'password', value: s.password2, autocomplete: 'new-password', on: {input: (e) => (s.password2 = e.target.value)}})) : null,
        s.mode === 'tailscale' ? h('label.opt', {style: {display: 'flex', gap: '8px', marginTop: '6px'}}, h('input', {type: 'checkbox', checked: s.serve, on: {change: (e) => (s.serve = e.target.checked)}}), h('span', 'Run ', h('code', 'tailscale serve'), ' for me now (needs Tailscale installed and signed in)')) : null,
        h('div', {style: {display: 'flex', justifyContent: 'space-between', marginTop: '18px'}}, h('button.btn', {on: {click: () => ((s.step = 0), draw())}}, 'Back'), h('button.btn.primary', {on: {click: finish}}, 'Finish setup')),
      );
    } else {
      card.append(h('h1', "You're set"), h('p.lead', s.done ?? 'Rein is ready.'), h('button.btn.primary', {on: {click: () => (location.href = '/')}}, 'Open Rein'));
    }
    if (s.error) card.append(h('div.error-text', s.error));
    root.replaceChildren(card);
  };
  const finish = async () => {
    s.error = '';
    if (s.mode === 'password' && s.password !== s.password2) return ((s.error = "The passwords don't match."), draw());
    try {
      const r = await api('/api/setup', {body: {code: s.code, mode: s.mode, username: s.username, password: s.password, serve: s.serve}});
      s.done = [r.mode === 'local' ? 'Rein answers on this computer only.' : r.mode === 'tailscale' ? `Reach Rein from your devices through Tailscale${r.tailscale ? `: ${r.tailscale}` : ' (run tailscale serve --bg <port> on this computer)'}.` : "Your account is ready; you're signed in.", r.restart ?? ''].join(' ');
      s.step = 2;
    } catch (err) {
      s.error = err.message;
    }
    draw();
  };
  draw();
  return root;
}

function loginView() {
  const s = {u: '', p: '', error: ''};
  const err = h('div.error-text');
  const submit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      const r = await api('/api/login', {body: {username: s.u, password: s.p}, quiet: true});
      state.me = r.user;
      await afterSignIn();
      route();
      render();
    } catch (x) {
      err.textContent = x.message;
    }
  };
  return h('div.center', h('form.card', {on: {submit}}, h('div.brand', h('img', {src: '/icon.svg', alt: ''}), 'Rein'), h('h1', 'Sign in'), h('label.field', 'Username'), h('input', {type: 'text', autocomplete: 'username', on: {input: (e) => (s.u = e.target.value)}}), h('label.field', 'Password'), h('input', {type: 'password', autocomplete: 'current-password', on: {input: (e) => (s.p = e.target.value)}}), err, h('div', {style: {display: 'flex', justifyContent: 'flex-end', marginTop: '16px'}}, h('button.btn.primary', {type: 'submit'}, 'Sign in'))));
}

// ---------- routing ----------

function route() {
  const [where, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [view, arg] = where.split('/');
  state.view = view === 'files' || view === 'settings' ? view : 'chat';
  if (state.view === 'files') {
    const p = new URLSearchParams(query).get('path');
    void openFolder(p || state.files.path || state.project || state.home);
  }
  if (state.view === 'chat' && arg && /^[\da-f]{16}$/.test(arg) && state.chat?.id !== arg) void attachChat(arg);
}
window.addEventListener('hashchange', () => {
  route();
  render();
});
const go = (hash) => {
  state.sideOpen = false;
  if (location.hash === hash) (route(), render());
  else location.hash = hash;
};

// ---------- data ----------

/** The sidebar's data: projects you opened with their chats, one-off chats, archived ones. */
async function loadSidebar() {
  state.side = await api('/api/sidebar');
  state.projects = state.side.projects.map((p) => ({path: p.path, name: p.name}));
  if (state.project && !state.projects.some((p) => p.path === state.project)) state.project = state.projects[0]?.path ?? '';
}
const loadProjects = loadSidebar;
const loadChats = loadSidebar;
function setProject(p) {
  state.project = p;
  localStorage.setItem('rein.project', p);
  void loadSidebar().then(render);
}
const collapsed = new Set(JSON.parse(localStorage.getItem('rein.collapsed') ?? '[]'));
const toggleCollapsed = (key) => {
  collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
  localStorage.setItem('rein.collapsed', JSON.stringify([...collapsed]));
  renderSide();
};

// ---------- the shell ----------

function render() {
  const app = document.getElementById('app');
  if (!state.booted) return;
  if (state.setup) return app.replaceChildren(setupView());
  if (!state.me) return app.replaceChildren(loginView());
  const main = state.view === 'files' ? filesView() : state.view === 'settings' ? settingsView() : chatView();
  app.replaceChildren(h('div.shell' + (state.sideOpen ? '.open' : ''), {on: {click: (e) => state.sideOpen && e.target.classList.contains('shell') && ((state.sideOpen = false), render())}}, sidebar(), main));
  if (state.view === 'chat') afterChatRender();
}

function sidebar() {
  const side = state.side ?? {projects: [], oneoff: {open: [], saved: []}, archived: []};
  const active = (c) => state.view === 'chat' && state.chat && (state.chat.id === c.id || (c.session && state.chat.snapshot?.session === c.session));
  const archive = async (session, on = true) => {
    try {
      await api('/api/chats/archive', {body: {session, archived: on}});
      if (on && state.chat?.snapshot?.session === session) ((state.chat.es?.close(), (state.chat = undefined)), go('#/chat'));
      await loadSidebar();
      renderSide();
      toast(on ? 'Archived. Restore it from Archived at the bottom.' : 'Restored.');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const chatRow = (c, saved, cwd) => {
    const session = saved ? c.session : c.session;
    return h('div.chat-row' + (active(c) ? '.active' : ''),
      h('button.side-item', {on: {click: () => (saved ? void openSaved(c.session, cwd) : go(`#/chat/${c.id}`))}, title: c.title},
        h('span.dot' + (c.waiting ? '.wait' : c.busy ? '.busy' : saved ? '' : '.ok')), h('span.t', c.title || 'New chat'), saved && c.updatedAt ? h('span.meta', ago(c.updatedAt)) : null),
      session ? h('button.row-act', {title: 'Archive', on: {click: (e) => (e.stopPropagation(), archive(session))}}, icon('archive', 15)) : null,
    );
  };
  const chatsOf = (g, cwd) => [...g.open.map((c) => chatRow(c, false, cwd)), ...g.saved.map((c) => chatRow(c, true, cwd))];
  const project = (p) => {
    const key = `p:${p.path}`;
    const closed = collapsed.has(key);
    const n = p.open.length + p.saved.length;
    return h('div.proj' + (state.project === p.path ? '.current' : ''),
      h('div.proj-head',
        h('button.proj-toggle', {title: closed ? 'Expand' : 'Collapse', on: {click: () => toggleCollapsed(key)}}, h('span.chev' + (closed ? '' : '.open'), '›'), icon('folder', 15), h('span.t', p.name), closed && n ? h('span.meta', String(n)) : null),
        h('button.row-act', {title: `New chat in ${p.name}`, on: {click: () => newChat(p.path)}}, icon('plus', 15)),
        h('button.row-act', {title: 'More', on: {click: (e) => menu(e, [
          ['New chat here', () => newChat(p.path)],
          ['Show the files', () => go(`#/files?path=${encodeURIComponent(p.path)}`)],
          null,
          ['Close the project', () => closeProject(p)],
        ])}}, icon('more', 15)),
      ),
      closed ? null : h('div.proj-chats', n ? chatsOf(p, p.path) : h('div.empty-row', 'No chats yet')),
    );
  };
  const oneoffN = side.oneoff.open.length + side.oneoff.saved.length;
  return h('aside.side',
    h('div.side-top',
      h('div.brand', h('span.brandmark', '▁▃▅▇'), h('span', 'Rein')),
      h('div.side-actions',
        h('button.btn.primary', {title: 'A chat without a project', on: {click: () => newChat()}}, icon('plus', 16), 'New chat'),
        h('button.btn', {title: 'Open a folder as a project', on: {click: pickProject}}, icon('folder', 16), 'Open project'),
      ),
    ),
    h('div.side-scroll',
      oneoffN ? [h('div.side-label', 'Chats'), chatsOf(side.oneoff)] : null,
      h('div.side-label', 'Projects'),
      side.projects.length ? side.projects.map(project) : h('div.empty-row', 'Open a folder to work in it.'),
      side.archived.length ? [
        h('button.side-label.toggle', {on: {click: () => toggleCollapsed('archived')}}, h('span', `Archived (${side.archived.length})`), h('span.chev' + (collapsed.has('archived') ? '' : '.open'), '›')),
        collapsed.has('archived') ? null : side.archived.map((c) => h('div.chat-row.archived',
          h('button.side-item', {title: c.cwd ? tilde(c.cwd) : '', on: {click: () => openSaved(c.session, c.cwd)}}, h('span.dot'), h('span.t', c.title || 'Chat'), c.updatedAt ? h('span.meta', ago(c.updatedAt)) : null),
          h('button.row-act', {title: 'Restore', on: {click: () => archive(c.session, false)}}, icon('restore', 15)))),
      ] : null,
    ),
    h('div.side-bottom',
      h('button.side-item' + (state.view === 'files' ? '.active' : ''), {on: {click: () => go(`#/files?path=${encodeURIComponent(state.project || state.home)}`)}}, icon('folder', 16), h('span.t', 'Files')),
      h('button.side-item' + (state.view === 'settings' ? '.active' : ''), {on: {click: () => go('#/settings')}}, icon('gear', 16), h('span.t', 'Settings')),
    ),
  );
}

async function closeProject(p) {
  try {
    await api('/api/projects/close', {body: {path: p.path}});
    if (state.chat && state.chat.snapshot?.cwd === p.path && !state.chat.busy) ((state.chat.es?.close(), (state.chat = undefined)), go('#/chat'));
    if (state.project === p.path) state.project = '';
    await loadSidebar();
    render();
    toast(`Closed ${p.name}. Its chats are kept: open the folder again to see them.`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

const topbar = (title, extra = []) => h('div.topbar', h('button.icon-btn.menu-btn', {on: {click: () => ((state.sideOpen = true), render())}, 'aria-label': 'Menu'}, icon('menu')), h('div.title', title), ...extra);

// ---------- projects ----------

function pickProject() {
  openDialog({title: 'Open a project', start: state.project || state.home, action: 'Open', onPick: async (dir) => {
    await api('/api/projects', {body: {path: dir}});
    collapsed.delete(`p:${dir}`);
    setProject(dir);
    go('#/chat');
  }});
}
/** Move to… / Copy to…: the same dialog. */
const folderPicker = ({title, start, onPick, action = 'Choose'}) => openDialog({title, start, onPick, action});

/**
 * A folder chooser like an operating system's File → Open: quick access and drives on the left,
 * back / forward / up and an address bar, the folder's contents with sortable columns (files are
 * shown dimmed: you're choosing a folder), a filter, New folder, and the chosen folder at the bottom.
 */
function openDialog({title, start, action, onPick}) {
  const st = {dir: '', parent: undefined, entries: [], sel: undefined, back: [], fwd: [], sort: 'name', asc: true, filter: '', hidden: false, editing: false};
  const ov = h('div.overlay.open-dialog');
  const close = () => (ov.remove(), document.removeEventListener('keydown', keys));
  const done = (dir) => (close(), onPick(dir));
  const nav = h('nav.od-nav');
  const crumbs = h('div.od-crumbs');
  const filter = h('input.od-filter', {type: 'search', placeholder: 'Filter', on: {input: (e) => ((st.filter = e.target.value.toLowerCase()), draw())}});
  const body = h('div.od-list');
  const chosen = h('input.od-chosen', {type: 'text', on: {keydown: (e) => e.key === 'Enter' && go2(e.target.value, true)}});
  const btn = (ic, tip, fn) => h('button.icon-btn', {title: tip, on: {click: fn}}, icon(ic, 16));
  const backB = btn('back', 'Back', () => st.back.length && load(st.back.pop(), 'back'));
  const fwdB = btn('forward', 'Forward', () => st.fwd.length && load(st.fwd.pop(), 'fwd'));
  const upB = btn('up', 'Up', () => st.parent && load(st.parent));
  const load = async (dir, how) => {
    try {
      const r = await api(`/api/fs/list?path=${encodeURIComponent(dir)}${st.hidden ? '&hidden=1' : ''}`);
      if (st.dir && r.path !== st.dir) {
        if (how === 'back') st.fwd.push(st.dir);
        else if (how === 'fwd') st.back.push(st.dir);
        else ((st.back.push(st.dir)), (st.fwd = []));
      }
      Object.assign(st, {dir: r.path, parent: r.parent, entries: r.entries, sel: undefined, filter: ''});
      filter.value = '';
      draw();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  // Typed into the address bar or the folder box: a path (~ allowed), absolute or relative to here.
  const go2 = (text, choose) => {
    const t = text.trim();
    if (!t) return choose && done(st.dir);
    const target = /^(~|\/|[A-Za-z]:[\\/])/.test(t) ? t : join(st.dir, t);
    if (choose) api(`/api/fs/list?path=${encodeURIComponent(target)}`).then((r) => done(r.path), (e) => toast(e.message, 'error'));
    else load(target);
  };
  const segs = (p) => {
    const win = /^[A-Za-z]:/.test(p);
    const parts = p.split(/[\\/]+/).filter(Boolean);
    const out = [];
    let acc = win ? '' : '/';
    if (!win) out.push(['/', '/']);
    for (const part of parts) {
      acc = win && !acc ? `${part}\\` : join(acc, part);
      out.push([part, acc]);
    }
    return out;
  };
  const sortBy = (k) => ((st.asc = st.sort === k ? !st.asc : true), (st.sort = k), draw());
  const kindOf = (e) => (e.dir ? 'Folder' : (e.name.includes('.') ? e.name.split('.').pop().toUpperCase() + ' file' : 'File'));
  const draw = () => {
    backB.disabled = !st.back.length;
    fwdB.disabled = !st.fwd.length;
    upB.disabled = !st.parent;
    crumbs.replaceChildren(...(st.editing
      ? [h('input.od-addr', {type: 'text', value: tilde(st.dir), on: {keydown: (e) => (e.key === 'Enter' ? ((st.editing = false), go2(e.target.value)) : e.key === 'Escape' && ((st.editing = false), draw())), blur: () => ((st.editing = false), draw())}})]
      : [...segs(st.dir).flatMap(([name, p], i, all) => [h('button.crumb', {on: {click: () => load(p)}}, i === 0 && name === '/' ? icon('drive', 14) : name), ...(i < all.length - 1 ? [h('span.crumb-sep', '›')] : [])]), h('button.crumb-edit', {title: 'Type a path', on: {click: () => ((st.editing = true), draw(), crumbs.querySelector('input')?.select())}})]));
    crumbs.querySelector('input')?.focus();
    const rows = st.entries.filter((e) => !st.filter || e.name.toLowerCase().includes(st.filter));
    const dirFirst = (a, b) => (a.dir === b.dir ? 0 : a.dir ? -1 : 1);
    const cmp = {name: (a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}), modified: (a, b) => a.modified - b.modified, kind: (a, b) => kindOf(a).localeCompare(kindOf(b)), size: (a, b) => a.size - b.size}[st.sort];
    rows.sort((a, b) => dirFirst(a, b) || (st.asc ? 1 : -1) * cmp(a, b));
    const col = (k, label) => h('button.od-col' + (st.sort === k ? '.on' : ''), {on: {click: () => sortBy(k)}}, label, st.sort === k ? (st.asc ? ' ▲' : ' ▼') : '');
    body.replaceChildren(
      h('div.od-row.od-head', col('name', 'Name'), col('modified', 'Date modified'), col('kind', 'Type'), col('size', 'Size')),
      ...rows.map((e) => h('div.od-row' + (e.dir ? '' : '.file') + (st.sel === e.path ? '.sel' : ''), {
        tabIndex: e.dir ? 0 : -1,
        on: e.dir ? {click: () => ((st.sel = e.path), (chosen.value = e.name), draw()), dblclick: () => load(e.path)} : {},
      }, h('span.od-name', icon(e.dir ? 'folder' : 'file', 16), h('span', e.name)), h('span', e.modified ? new Date(e.modified).toLocaleString([], {dateStyle: 'short', timeStyle: 'short'}) : ''), h('span', kindOf(e)), h('span', e.dir ? '' : fmtSize(e.size)))),
      !rows.length ? h('div.od-empty', st.filter ? 'Nothing matches.' : 'This folder is empty.') : null,
    );
    if (!st.sel) chosen.value = '';
    chosen.placeholder = base(st.dir) || st.dir;
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('on', b.dataset.path === st.dir);
    body.querySelector('.sel')?.scrollIntoView({block: 'nearest'});
  };
  const keys = (e) => {
    if (!document.body.contains(ov)) return;
    if (e.target.tagName === 'INPUT' && e.target !== chosen) return;
    const dirs = st.entries.filter((x) => x.dir && (!st.filter || x.name.toLowerCase().includes(st.filter)));
    if (e.key === 'Escape') close();
    else if (e.key === 'Backspace' && e.target !== chosen) (e.preventDefault(), st.parent && load(st.parent));
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && dirs.length) {
      e.preventDefault();
      const i = dirs.findIndex((x) => x.path === st.sel);
      const next = dirs[Math.max(0, Math.min(dirs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      Object.assign(st, {sel: next.path});
      chosen.value = next.name;
      draw();
    } else if (e.key === 'Enter' && e.target !== chosen && st.sel) (e.preventDefault(), load(st.sel));
  };
  document.addEventListener('keydown', keys);
  const newFolder = async () => {
    const name = prompt('New folder name');
    if (!name) return;
    try {
      await api('/api/fs/mkdir', {body: {path: join(st.dir, name)}});
      await load(st.dir);
      const made = st.entries.find((x) => x.name === name);
      if (made) ((st.sel = made.path), (chosen.value = name), draw());
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  ov.append(h('div.dialog.od',
    h('header', title, h('button.icon-btn', {style: {float: 'right'}, title: 'Cancel', on: {click: close}}, icon('x'))),
    h('div.od-bar', backB, fwdB, upB, crumbs, filter),
    h('div.od-main', nav, body),
    h('div.od-foot',
      h('label', 'Folder:'), chosen,
      h('label.od-hidden', h('input', {type: 'checkbox', on: {change: (e) => ((st.hidden = e.target.checked), load(st.dir))}}), ' Hidden'),
      h('button.btn', {on: {click: newFolder}}, icon('newfolder', 15), 'New folder'),
      h('span.grow'),
      h('button.btn', {on: {click: close}}, 'Cancel'),
      h('button.btn.primary', {on: {click: () => (st.sel ? done(st.sel) : go2(chosen.value, true))}}, action),
    ),
  ));
  document.body.append(ov);
  // Quick access, recent projects, then drives.
  api('/api/fs/roots').then(({roots}) => {
    const item = (r, ic) => h('button.od-place', {'data-path': r.path, title: r.path, on: {click: () => load(r.path)}}, icon(ic, 15), h('span', r.name));
    nav.replaceChildren(
      h('div.od-group', 'Quick access'), ...roots.filter((r) => r.kind !== 'drive').map((r) => item(r, r.name === 'Home' ? 'home' : 'folder')),
      state.projects.length ? h('div.od-group', 'Projects') : null, ...state.projects.slice(0, 8).map((p) => item(p, 'folder')),
      h('div.od-group', 'This computer'), ...roots.filter((r) => r.kind === 'drive').map((r) => item(r, 'drive')),
    );
    draw();
  }, () => {});
  void load(start || state.home);
}

// ---------- chats ----------

/** A new chat: in a project, or (no project given) a one-off chat with its own folder. */
async function newChat(project) {
  try {
    toast('Starting a chat…');
    const r = await api('/api/chats', {body: project ? {project} : {oneoff: true}});
    if (project) ((state.project = project), localStorage.setItem('rein.project', project));
    await loadSidebar();
    go(`#/chat/${r.id}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}
async function openSaved(session, cwd) {
  try {
    const r = await api('/api/chats', {body: {project: cwd || state.project, resume: session}});
    await loadSidebar();
    go(`#/chat/${r.id}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function attachChat(id) {
  if (!/^[\da-f]{16}$/.test(id)) return;
  state.chat?.es?.close();
  const c = {id, snapshot: undefined, live: '', tools: [], asks: new Map(), busy: false, notes: [], model: undefined, es: undefined, stick: true, feed: [], window: undefined, ui: undefined};
  state.chat = c;
  const es = new EventSource(`/api/chats/${id}/events`);
  c.es = es;
  es.onmessage = (m) => {
    if (state.chat !== c) return es.close();
    onEvent(c, JSON.parse(m.data));
  };
  es.onerror = () => {
    if (state.chat !== c) return;
    // The server closes the stream when the chat ends; EventSource retries otherwise.
    if (es.readyState === EventSource.CLOSED) toast('This chat closed. Open it again from the list.', 'error');
  };
  render();
}

function onEvent(c, ev) {
  switch (ev.type) {
    case 'snapshot':
      c.snapshot = ev.snapshot;
      renderChrome(c);
      c.busy = ev.snapshot.busy;
      if (!c.busy) Object.assign(c, {live: '', tools: [], notes: [], model: undefined});
      void loadChats().then(() => state.view === 'chat' && renderSide());
      break;
    case 'busy':
      c.busy = ev.busy;
      if (ev.phrase) c.phrase = ev.phrase;
      if (ev.busy) Object.assign(c, {live: '', tools: [], notes: [], model: undefined, route: undefined});
      void loadChats().then(() => state.view === 'chat' && renderSide());
      break;
    case 'user': {
      const last = c.snapshot?.messages.at(-1);
      if (c.snapshot && !(last?.role === 'user' && last.text === ev.text)) c.snapshot.messages = [...c.snapshot.messages, {role: 'user', text: ev.text, at: Date.now()}];
      if (c.snapshot && c.snapshot.title === 'New chat') c.snapshot.title = ev.text.split('\n')[0].slice(0, 80);
      break;
    }
    case 'text':
      c.live += ev.delta;
      break;
    case 'tool':
      if (ev.phase === 'start') c.tools.push({...ev, pending: true, after: c.live.length});
      else {
        const t = c.tools.find((x) => x.id === ev.id && x.pending);
        if (t) Object.assign(t, ev, {pending: false});
        else c.tools.push({...ev, after: c.live.length});
      }
      break;
    case 'route':
      c.model = ev.model;
      if (ev.line) c.route = ev.line;
      break;
    case 'notice':
      c.notes.push({text: ev.text});
      break;
    case 'error':
      c.notes.push({text: ev.message, error: true});
      break;
    case 'compact':
      if (ev.phase === 'start') c.notes.push({text: `Compacting ${ev.messages} messages…`});
      break;
    case 'waiting':
      c.notes.push({text: `Every account is at its limit: continuing at ${new Date(ev.until).toLocaleTimeString()}.`});
      break;
    case 'cmd':
    case 'log':
    case 'usage':
    case 'context':
      // What commands print, in the thread where they were typed (after the messages so far).
      c.feed.push({...ev, at: c.snapshot?.messages.length ?? 0});
      break;
    case 'clear':
      c.feed = [];
      break;
    case 'window':
      // A live refresh (shells, subagents) keeps what's open in the window; a new window starts fresh.
      if (!ev.refresh) c.winUi = {};
      c.window = ev.close ? undefined : ev.window;
      if (ev.refresh && document.activeElement?.closest?.('.cmd-window textarea, .cmd-window input')) return void (c.windowStale = true);
      renderWindow(c);
      return;
    case 'chrome':
      if (c.snapshot) Object.assign(c.snapshot, {status: ev.status, sidebar: ev.sidebar, queued: ev.queued, mode: ev.mode, chatModel: ev.chatModel});
      renderChrome(c);
      updateComposer(c);
      return;
    case 'ask':
      c.asks.set(ev.id, ev);
      break;
    case 'answered':
      c.asks.delete(ev.id);
      break;
  }
  scheduleThread();
}

let threadFrame = 0;
function scheduleThread() {
  if (threadFrame) return;
  threadFrame = requestAnimationFrame(() => {
    threadFrame = 0;
    if (state.view !== 'chat') return;
    const scroll = $('.scroll');
    const thread = $('#thread');
    if (!thread) return render();
    const stick = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120 : true;
    thread.replaceWith(threadEl());
    if (state.chat) updateComposer(state.chat);
    const title = $('.topbar .title');
    if (title && state.chat?.snapshot) title.textContent = state.chat.snapshot.title;
    if (scroll && stick) scroll.scrollTop = scroll.scrollHeight;
  });
}
function renderSide() {
  const side = $('.side');
  if (side) side.replaceWith(sidebar());
}

/** A tool call as the terminal shows it: ● Shell(npm test) · allowed by rule, then ⎿ its result in a line. Click for all of it. */
function toolEl(t) {
  const status = t.pending ? 'run' : t.ok === false ? 'bad' : t.label === 'Agent' ? 'agent' : 'ok';
  const stats = t.diff?.length ? diffStats(t.diff) : undefined;
  const head = h('summary.tl',
    h('span.td.' + status, '●'),
    h('b', t.label), h('span.ta', `(${t.summary})`),
    stats ? [h('span.plus', ` +${stats.added}`), h('span.minus', ` −${stats.removed}`)] : null,
    t.note ? h('span.tn', ` · ${t.note}`) : null,
  );
  const brief = !t.pending && t.brief && !t.diff?.length ? h('div.tb' + (t.ok === false ? '.bad' : ''), (t.ok === false ? '✗ ' : '') + t.brief) : null;
  const d = h('details.tool', head);
  if (t.diff?.length) d.append(diffEl(t.diff));
  if (t.result && (t.result.includes('\n') || t.result.length > 120)) d.append(h('pre.out', t.result));
  if (t.warning) d.append(h('div.tw', '⚠ ' + t.warning));
  if (t.diff?.length) d.open = true; // edits show their diff, as in the terminal
  return h('div.toolrow', d, brief);
}

function diffStats(diff) {
  let added = 0, removed = 0;
  for (const l of diff) l.kind === 'add' ? added++ : l.kind === 'del' && removed++;
  return {added, removed};
}

/** Words that differ between a removed line and the added line after it, marked (as the terminal does). */
function wordDiff(a, b) {
  const A = a.split(/(\s+|[^\w\s])/).filter(Boolean), B = b.split(/(\s+|[^\w\s])/).filter(Boolean);
  if (A.length * B.length > 40000) return [[a, true], [b, true]].map(([x]) => [[x, true]]);
  const L = Array.from({length: A.length + 1}, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const da = [], db = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) da.push([A[i++], false]), db.push([B[j++], false]);
    else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) db.push([B[j++], true]);
    else da.push([A[i++], true]);
  }
  return [da, db];
}

function diffEl(diff) {
  const rows = [];
  for (let k = 0; k < diff.length; k++) {
    const l = diff[k];
    if (l.kind === 'gap') { rows.push(h('div.gap', '⋯')); continue; }
    if (l.kind === 'note') { rows.push(h('div.dnote', l.text)); continue; }
    const pair = l.kind === 'del' && diff[k + 1]?.kind === 'add' ? diff[k + 1] : undefined;
    const parts = pair ? wordDiff(l.text, pair.text) : undefined;
    const line = (x, segs) => h('div.' + x.kind, h('span.no', x.n ?? ''), h('span.sg', x.kind === 'add' ? '+' : x.kind === 'del' ? '-' : ' '), h('span.tx', segs ? segs.map(([w, ch]) => (ch ? h('mark', w) : w)) : x.text));
    rows.push(line(l, parts?.[0]));
    if (pair) rows.push(line(pair, parts[1])), k++;
  }
  return h('div.diff', rows);
}

function messageEl(m) {
  if (m.role === 'user') return h('div.msg.user', h('div.bubble', m.text));
  return h('div.msg.assistant', (m.tools ?? []).map(toolEl), m.text ? h('div.reply', md(m.text)) : null, m.interrupted ? h('div.note', 'Interrupted.') : null, m.model ? h('div.model-tag', m.model.split(':').pop()) : null);
}

function askEl(c, a) {
  const answer = async (value) => {
    try {
      await api(`/api/chats/${c.id}/answer`, {body: {id: a.id, value}});
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  if (a.kind === 'approval') {
    const p = a.payload;
    return h('div.ask',
      h('h3', `Allow ${p.tool}?`),
      h('div.sub', p.summary),
      p.outside?.length ? h('div.note', `Outside the project: ${p.outside.join(', ')}`) : null,
      p.preview ? h('pre', p.preview) : null,
      h('div.actions', h('button.btn.primary', {on: {click: () => answer('once')}}, 'Allow'), !p.sensitive ? h('button.btn', {on: {click: () => answer('session')}}, 'Allow for this session') : null, h('button.btn.danger', {on: {click: () => answer('deny')}}, 'Deny')),
    );
  }
  if (a.kind === 'question') {
    const answers = a.payload.questions.map((q) => ({id: q.id, selected: [], other: ''}));
    return h('div.ask',
      h('h3', 'The agent has a question'),
      a.payload.questions.map((q, i) => h('div.q',
        h('b', q.question),
        q.options.map((o) => h('label.opt', h('input', {type: q.multi ? 'checkbox' : 'radio', name: `q${a.id}-${i}`, on: {change: (e) => {
          const sel = answers[i].selected;
          if (!q.multi) sel.length = 0;
          if (e.target.checked) sel.push(o.label);
          else sel.splice(sel.indexOf(o.label), 1);
        }}}), h('span', o.label, o.description ? h('small', o.description) : null))),
        h('input', {type: 'text', placeholder: 'Something else…', on: {input: (e) => (answers[i].other = e.target.value)}}),
      )),
      h('div.actions', h('button.btn.primary', {on: {click: () => answer(answers.map((x) => ({id: x.id, selected: x.selected, ...(x.other.trim() ? {other: x.other.trim()} : {})})))}}, 'Answer'), h('button.btn', {on: {click: () => answer(undefined)}}, 'Dismiss')),
    );
  }
  if (a.kind === 'plan') {
    const p = a.payload;
    return h('div.ask',
      h('h3', `Plan: ${p.title}`),
      md(p.plan),
      p.milestones?.length ? h('ol', p.milestones.map((m) => h('li', m))) : null,
      h('div.actions', h('button.btn.primary', {on: {click: () => answer('implement')}}, 'Implement it now'), h('button.btn', {on: {click: () => answer('goal')}}, 'Start as a goal'), h('button.btn', {on: {click: () => answer('save')}}, 'Save for later'), h('button.btn.ghost', {on: {click: () => answer('revise')}}, 'Keep planning')),
    );
  }
  if (a.kind === 'vault') {
    const v = {value: ''};
    return h('div.ask',
      h('h3', `Value for ${a.payload.secret}`),
      h('div.sub', 'Saved in the vault on the computer Rein runs on, never in the conversation. The agent\'s shell commands get it as an environment variable.'),
      h('input', {type: 'password', autocomplete: 'off', on: {input: (e) => (v.value = e.target.value)}}),
      h('div.actions', h('button.btn.primary', {on: {click: () => answer(v.value)}}, 'Save'), h('button.btn', {on: {click: () => answer(undefined)}}, 'Cancel')),
    );
  }
  return h('div.ask', h('h3', 'Rein needs you'), h('pre', JSON.stringify(a.payload, null, 2)));
}

function threadEl() {
  const c = state.chat;
  const s = c?.snapshot;
  if (!s) return h('div.thread#thread', h('div.note', 'Starting…'));
  if (!s.messages.length && !c.busy && !c.live && !c.feed.length && !c.asks.size) {
    const hour = new Date().getHours();
    return h('div.thread#thread', h('div.empty', h('h1', hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'), h('p', isOneOff(s.cwd) ? 'What should we do?' : `What should we do in ${base(s.cwd)}?`)));
  }
  // The turn in progress: the reply so far with its tool calls where they happened.
  const live = [];
  if (c.busy || c.live || c.tools.length) {
    if (c.route) live.push(h('div.route', `→ ${c.route}`));
    let at = 0;
    for (const t of c.tools) {
      if (t.after > at) live.push(md(c.live.slice(at, t.after)));
      at = Math.max(at, t.after);
      live.push(toolEl(t));
    }
    if (c.live.length > at) live.push(md(c.live.slice(at)));
  }
  // Messages, with what commands printed after the message they were typed after.
  const rows = [];
  const feedAt = (i) => c.feed.filter((f) => f.at === i).map(feedEl);
  rows.push(feedAt(0));
  s.messages.forEach((m, i) => rows.push(messageEl(m), feedAt(i + 1)));
  rows.push(c.feed.filter((f) => f.at > s.messages.length).map(feedEl));
  return h('div.thread#thread',
    rows,
    live.length ? h('div.msg.assistant', live) : null,
    c.notes.map((n) => h('div.note' + (n.error ? '.error' : /^(Load balancing|Failover|Every account)/.test(n.text) ? '.warn' : ''), n.text)),
    [...c.asks.values()].map((a) => askEl(c, a)),
  );
}

/** A command's echo, its output, and the /usage and /context reports. */
function feedEl(f) {
  if (f.type === 'cmd') return h('div.cmd', h('span.p', '›'), f.text);
  if (f.type === 'log') return h('div.out' + (f.kind === 'error' ? '.error' : ''), f.text);
  if (f.type === 'usage')
    return h('div.out.report', !f.rows.length ? 'No accounts. Sign in from a terminal: rein, then /login.' : f.rows.map((r) => h('div.acct',
      h('div', h('b', r.provider), ' ', r.account, r.plan ? h('span.muted', ` · ${r.plan}`) : null, r.cooldownUntil ? h('span.bad', ` · limited until ${new Date(r.cooldownUntil).toLocaleTimeString()}`) : null),
      r.error ? h('div.bad', r.error) : null,
      r.windows.map((w) => h('div.meter', h('span.l', w.label), bar(w.usedPct), h('span.n', `${w.usedPct}%`), w.resetsAt ? h('span.muted', ` resets ${new Date(w.resetsAt).toLocaleString()}`) : null)),
    )));
  if (f.type === 'context') {
    const r = f.report;
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
    const used = r.measured ?? r.used;
    return h('div.out.report',
      h('div', h('b', r.modelLabel), ` · ${k(used)}/${k(r.window)} tokens (${((used / r.window) * 100).toFixed(1)}%${r.measured !== undefined ? ', measured' : ', est.'})`),
      h('div.ctxbar', r.categories.map((cat) => h('i.' + cat.key, {style: {width: `${(cat.tokens / r.window) * 100}%`}, title: `${cat.label}: ${k(cat.tokens)}`}))),
      r.categories.map((cat) => h('div.legend', h('i.' + cat.key), `${cat.label}: `, h('b', k(cat.tokens)), h('span.muted', ` (${((cat.tokens / r.window) * 100).toFixed(1)}%)`))),
      h('div.legend', h('i.free'), `Free space: ${k(Math.max(0, r.window - used))}`),
      h('div.muted', `${r.messageCount} messages${r.summarizedCount ? ` · ${r.summarizedCount} summarized` : ''} · compacts at ${k(r.autoCompactAt)}`),
      r.largest?.length ? h('div.muted', 'Largest: ' + r.largest.slice(0, 5).map((x) => `${x.what} (${k(x.tokens)})`).join(' · ')) : null,
    );
  }
  return null;
}
const bar = (pct) => h('span.mbar' + (pct >= 90 ? '.hot' : pct >= 70 ? '.warm' : ''), h('i', {style: {width: `${Math.min(100, pct)}%`}}));

/** The request helper for a chat's worker: the / list, settings, model choices. */
const ask = (c, op, args = {}) => api(`/api/chats/${c.id}/request`, {body: {op, args}}).then((r) => r.value);

/** The input: built once per chat (typing never loses focus mid-reply); updateComposer refreshes the rest. */
function composer() {
  const c = state.chat;
  if (c?.ui) return c.ui.wrap;
  const ta = h('textarea', {rows: 1, placeholder: 'Message Rein, / for commands'});
  const list = h('div.cmdlist.hidden');
  const sug = {items: [], index: 0, text: undefined};
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  };
  const showList = () => {
    list.classList.toggle('hidden', !sug.items.length);
    list.replaceChildren(...sug.items.map((it, i) => h('button.cmd-item' + (i === sug.index ? '.on' : ''), {on: {mousedown: (e) => (e.preventDefault(), pick(i))}},
      h('span.name', `/${it.name}`), h('span.desc', it.description), it.tag ? h('span.tag', it.tag) : null)));
    list.querySelector('.on')?.scrollIntoView({block: 'nearest'});
  };
  let timer = 0;
  const suggest = () => {
    const text = ta.value;
    clearTimeout(timer);
    if (!/^\/[^\s]*$/.test(text)) {
      sug.items = [];
      return showList();
    }
    timer = setTimeout(async () => {
      const items = await ask(c, 'suggest', {text}).then((r) => (Array.isArray(r) ? r : []), () => []);
      if (ta.value !== text) return;
      Object.assign(sug, {items, index: 0, text});
      showList();
    }, 40);
  };
  const pick = (i) => {
    const it = sug.items[i];
    if (!it) return;
    ta.value = `/${it.name} `;
    sug.items = [];
    showList();
    ta.focus();
    fit();
  };
  const send = async (text = ta.value.trim()) => {
    if (!text || !c) return;
    c.draft = '';
    ta.value = '';
    fit();
    sug.items = [];
    showList();
    // A message shows right away; a command's echo comes back from the worker.
    if (!/^[\/!]/.test(text) && !c.busy) {
      c.snapshot = {...c.snapshot, messages: [...c.snapshot.messages, {role: 'user', text, at: Date.now()}]};
      c.busy = true;
    }
    scheduleThread();
    try {
      await api(`/api/chats/${c.id}/send`, {body: {text}});
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  ta.addEventListener('input', () => {
    fit();
    if (c) c.draft = ta.value;
    sendBtn.disabled = !ta.value.trim();
    suggest();
  });
  ta.addEventListener('keydown', (e) => {
    // A list for what was typed a moment ago is stale: Enter sends what's in the box.
    if (sug.items.length && sug.text === ta.value) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sug.index = (sug.index + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
        return showList();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        return pick(sug.index);
      }
      if (e.key === 'Escape') {
        sug.items = [];
        return showList();
      }
      // Enter fills in the highlighted command; typed out in full, it runs (as in the terminal).
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(sug.index === 0 && `/${sug.items[0].name}` === ta.value.trim().toLowerCase())) {
        e.preventDefault();
        return pick(sug.index);
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
    if (e.key === 'Escape' && c?.busy) void api(`/api/chats/${c.id}/interrupt`, {body: {}}).catch(() => {});
  });
  ta.addEventListener('blur', () => setTimeout(() => ((sug.items = []), showList()), 120));
  if (c?.draft) ta.value = c.draft;
  const sendBtn = h('button.send', {disabled: !ta.value.trim(), title: 'Send (Enter)', on: {click: () => send()}}, icon('send', 17));
  const stopBtn = h('button.send.stop', {title: 'Stop (Esc)', on: {click: () => api(`/api/chats/${c.id}/interrupt`, {body: {}}).catch((e) => toast(e.message, 'error'))}}, icon('stop', 15));
  const model = h('select', {title: 'Model', on: {change: (e) => api(`/api/chats/${c.id}/model`, {body: {model: e.target.value}}).catch((x) => toast(x.message, 'error'))}});
  const mode = h('select', {title: 'Approvals', on: {change: (e) => api(`/api/chats/${c.id}/mode`, {body: {mode: e.target.value}}).catch((x) => toast(x.message, 'error'))}},
    [['ask', 'Ask before changes'], ['auto', 'Auto-approve'], ['bypass', 'Allow everything'], ['plan', 'Plan only']].map(([v, l]) => h('option', {value: v}, l)),
  );
  const working = h('div.working.hidden');
  const queued = h('div.queued.hidden');
  const action = h('span.action');
  const wrap = h('div.composer-wrap#composer-wrap', working, queued, h('div.composer-box', list, h('div.composer', ta, h('div.row', model, mode, h('span.spacer'), action))));
  if (c) c.ui = {wrap, ta, sendBtn, stopBtn, model, mode, working, queued, action};
  updateComposer(c);
  return wrap;
}

function updateComposer(c) {
  const u = c?.ui;
  if (!u) return;
  const s = c.snapshot;
  u.ta.placeholder = c.busy ? 'Queue a message, or /btw <question>' : 'Message Rein, / for commands';
  u.working.classList.toggle('hidden', !c.busy);
  u.working.replaceChildren(h('span.spin', '▁▃▅▇'), c.asks.size ? h('span.wait', 'Waiting for you') : h('span.rainbow', `${c.phrase ?? 'Thinking'}…`), c.model && !c.asks.size ? h('span.dimtxt', ` · ${c.model}`) : null);
  const q = s?.queued ?? [];
  u.queued.classList.toggle('hidden', !q.length);
  u.queued.replaceChildren(...q.map((t, i) => h('span.chip', {title: t}, `Queued: ${t.length > 60 ? t.slice(0, 60) + '…' : t}`, h('button', {title: 'Remove', on: {click: () => ask(c, 'unqueue', {index: i}).catch((e) => toast(e.message, 'error'))}}, '×'))));
  u.action.replaceChildren(c.busy && !u.ta.value.trim() ? u.stopBtn : u.sendBtn);
  u.model.disabled = u.mode.disabled = !s;
  const opts = [h('option', {value: 'auto'}, 'Auto'), ...(s?.models ?? []).map((m) => h('option', {value: m.ref}, `${m.label} · ${m.provider === 'claude' ? 'Claude' : 'Codex'}`))];
  if (u.model.options.length !== opts.length) u.model.replaceChildren(...opts);
  u.model.value = s?.chatModel ?? 'auto';
  u.mode.value = s?.mode ?? 'ask';
}

function chatView() {
  const c = state.chat;
  if (!c) {
    const hour = new Date().getHours();
    return h('main.main', topbar('Rein'), h('div.scroll', h('div.empty',
      h('div.big-mark.brandmark', '▁▃▅▇'),
      h('h1', hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'),
      h('p', 'Start a chat, or work in a project folder.'),
      h('div.empty-actions',
        h('button.btn.primary', {on: {click: () => newChat()}}, icon('plus', 16), 'New chat'),
        state.project ? h('button.btn', {on: {click: () => newChat(state.project)}}, icon('folder', 16), `Chat in ${base(state.project)}`) : null,
        h('button.btn', {on: {click: pickProject}}, icon('folder', 16), 'Open a project'),
      ),
    )));
  }
  const s = c.snapshot;
  // Wide screens: the sidebar sits beside the chat (on unless you turned it off). Narrow ones: it slides over, when asked.
  const wide = innerWidth >= 1100;
  const panelOpen = wide ? localStorage.getItem('rein.panel') !== 'off' : !!state.panelShow;
  const togglePanel = () => {
    if (wide) localStorage.setItem('rein.panel', panelOpen ? 'off' : 'on');
    else state.panelShow = !panelOpen;
    render();
  };
  return h('main.main.chat' + (panelOpen ? '.with-panel' : ''),
    topbar(s?.title ?? 'Chat', [s && !isOneOff(s.cwd) ? h('span.path', tilde(s.cwd)) : null, h('button.icon-btn', {title: 'Sidebar', on: {click: togglePanel}}, icon('panel')), h('button.icon-btn', {title: 'More', on: {click: (e) => chatMenu(e, c)}}, icon('more'))]),
    statusEl(c),
    h('div.chat-body', h('div.chat-col', h('div.scroll', threadEl()), composer()), panelOpen ? panelEl(c) : null, panelOpen && !wide ? h('div.rpanel-backdrop', {on: {click: togglePanel}}) : null),
  );
}

/** The status line: the segments set in /settings → Status line, then marketplace items'. Click one for its command. */
function statusEl(c) {
  const segs = c.snapshot?.status ?? [];
  const items = [];
  segs.forEach((g, i) => {
    if (i) items.push(h('span.sep', '│'));
    items.push(h(g.command ? 'button.seg' : 'span.seg', {title: g.command ? `${g.label}: ${g.command}` : g.label, on: g.command ? {click: () => runInChat(c, g.command)} : undefined}, h('span.k', g.label), ' ', h('span.v' + (g.tone ? '.' + g.tone : ''), g.value)));
  });
  return h('div.statusline#statusline', h('span.brandmark', '▁▃▅▇ Rein'), items.length ? h('span.sep', '│') : null, items);
}

/** The right sidebar: the goal's plan and tasks, the sections set in /settings → Sidebar, then items' sections. */
function panelEl(c) {
  const secs = c.snapshot?.sidebar ?? [];
  return h('aside.rpanel#rpanel', secs.map((sec) => h('section',
    h('h4', sec.title.toUpperCase()),
    sec.rows.map((r) => {
      const mark = /^([✓▸○●])\s/.exec(r.text ?? '');
      const tone = mark ? {'✓': '.done', '▸': '.next', '○': '.later', '●': '.on'}[mark[1]] : '';
      const kids = [r.text ? h('span.t', r.text) : null, r.pct !== undefined ? h('span.n', `${r.pct}%`) : null];
      const cls = (r.dim ? '.dim' : '') + (r.bold ? '.bold' : '') + (r.active ? '.active' : '') + tone;
      const row = r.command ? h('button.row' + cls, {on: {click: () => runInChat(c, r.command)}}, kids) : h('div.row' + cls, kids);
      return r.pct !== undefined ? [row, h('div.meter', h('i' + (r.pct >= 90 ? '.hot' : r.pct >= 70 ? '.warm' : ''), {style: {width: `${Math.min(100, r.pct)}%`}}))] : row;
    }),
  )), !secs.length ? h('div.muted', {style: {padding: '12px'}}, 'Nothing here: choose sections in /settings → Sidebar.') : null);
}

function renderChrome(c) {
  if (state.chat !== c || state.view !== 'chat') return;
  $('#statusline')?.replaceWith(statusEl(c));
  $('#rpanel')?.replaceWith(panelEl(c));
}

/** Run a command in the chat, as if typed. */
function runInChat(c, text) {
  return api(`/api/chats/${c.id}/send`, {body: {text}}).catch((e) => toast(e.message, 'error'));
}
function afterChatRender() {
  if (state.chat?.window) renderWindow(state.chat);
  const scroll = $('.scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
  $('.composer textarea')?.focus();
}
function chatMenu(e, c) {
  menu(e, [
    ['Compact the conversation', () => api(`/api/chats/${c.id}/compact`, {body: {}}).catch((x) => toast(x.message, 'error'))],
    ['Show the project files', () => go(`#/files?path=${encodeURIComponent(c.snapshot?.cwd ?? state.project)}`)],
    null,
    ['Close this chat', async () => {
      await api(`/api/chats/${c.id}`, {method: 'DELETE'}).catch(() => {});
      c.es?.close();
      state.chat = undefined;
      await loadChats();
      go('#/chat');
    }, 'danger'],
  ]);
}

function menu(e, items) {
  e.stopPropagation();
  document.querySelector('.menu')?.remove();
  const m = h('div.menu', items.map((it) => (it ? h('button' + (it[2] === 'danger' ? '.danger' : ''), {on: {click: () => (m.remove(), it[1]())}}, it[0]) : h('hr'))));
  document.body.append(m);
  const r = (e.currentTarget ?? e.target).getBoundingClientRect?.() ?? {left: e.clientX, bottom: e.clientY};
  const x = Math.min(e.clientX ?? r.left, innerWidth - m.offsetWidth - 8);
  const y = Math.min(e.clientY ?? r.bottom, innerHeight - m.offsetHeight - 8);
  Object.assign(m.style, {left: `${x}px`, top: `${y}px`});
  setTimeout(() => document.addEventListener('click', () => m.remove(), {once: true}));
}

// ---------- windows a command opens (/settings, /model, /goal:plan, /mcp…) ----------

function closeWindow(c) {
  c.window = undefined;
  renderWindow(c);
  void api(`/api/chats/${c.id}/window`, {body: {}}).catch(() => {});
}

function renderWindow(c) {
  document.querySelector('.overlay.cmd-window')?.remove();
  if (state.chat !== c || !c.window) return;
  const w = c.window;
  const panels = {login: loginPanel, settings: settingsPanel, model: modelPanel, plans: plansPanel, rewind: rewindPanel, shells: shellsPanel, agents: agentsPanel};
  const body = panels[w.name] ? panels[w.name](c, w) : h('pre.text', (w.lines ?? []).join('\n'));
  const title = {login: 'Accounts', settings: 'Settings', model: 'Models', plans: 'Start a plan as a goal', rewind: 'Rewind', shells: 'Shells', agents: 'Subagents'}[w.name] ?? w.title;
  const o = h('div.overlay.cmd-window', {on: {click: (e) => e.target === o && closeWindow(c)}},
    h('div.dialog.wide', h('header', title, h('button.icon-btn', {style: {float: 'right'}, title: 'Close (Esc)', on: {click: () => closeWindow(c)}}, icon('x'))), h('div.body', body)));
  o.tabIndex = -1;
  o.addEventListener('keydown', (e) => e.key === 'Escape' && closeWindow(c));
  document.body.append(o);
  o.focus();
}

/** Every /settings tab, as in the terminal: the status line and sidebar layout, the choices, and every key (Advanced). */
function settingsPanel(c, v) {
  const tab = v.tab;
  const set = (patch) => {
    c.window = {...c.window, ...patch, name: 'settings'};
    renderWindow(c);
  };
  const apply = async (op, args) => {
    try {
      set(await ask(c, op, {...args, tab}));
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const tabs = h('div.tabs', v.tabs.map((t) => h('button.tab' + (t === tab ? '.on' : ''), {on: {click: () => set({tab: t})}}, t)));
  let body;
  const layout = v.layouts.find((l) => l.title === tab);
  const group = v.groups.find((g) => g.group === tab);
  if (layout) {
    const on = layout.items.filter((i) => i.on).map((i) => i.id);
    const save = (ids) => apply('layout', {key: layout.key, ids});
    body = h('div.layout',
      h('p.muted', layout.key === 'statusLine' ? 'Segments of the status line, left to right. Check to show; arrows reorder.' : 'Sections of the sidebar, top to bottom. Check to show; arrows reorder.'),
      layout.items.map((it) => {
        const i = on.indexOf(it.id);
        return h('div.lrow',
          h('label', h('input', {type: 'checkbox', checked: it.on, on: {change: (e) => save(e.target.checked ? [...on, it.id] : on.filter((x) => x !== it.id))}}), h('b', it.label), h('span.muted', it.description)),
          it.on ? h('span.move', h('button.icon-btn', {disabled: i === 0, title: 'Up', on: {click: () => save(on.map((x, j) => (j === i - 1 ? it.id : j === i ? on[i - 1] : x)))}}, '↑'), h('button.icon-btn', {disabled: i === on.length - 1, title: 'Down', on: {click: () => save(on.map((x, j) => (j === i + 1 ? it.id : j === i ? on[i + 1] : x)))}}, '↓')) : null,
        );
      }),
    );
  } else if (group) {
    body = h('div', group.settings.map((st) => h('section.setting',
      h('h3', st.title), h('p.muted', st.description),
      st.choices.map((ch) => h('label.opt', h('input', {type: 'radio', name: `set-${st.key}`, checked: JSON.stringify(ch.value) === JSON.stringify(st.value ?? st.choices[0].value), on: {change: () => apply('setting', {key: st.key, value: ch.value})}}), h('span', ch.label))),
    )));
  } else {
    const q = {text: ''};
    const rows = h('div.adv');
    const draw = () => rows.replaceChildren(...v.advanced.filter((k) => !q.text || k.key.toLowerCase().includes(q.text) || k.description.toLowerCase().includes(q.text)).map((k) => {
      const input =
        k.kind === 'boolean' ? h('select', {on: {change: (e) => apply('setting', {key: k.key, value: e.target.value, typed: true})}}, ['', 'true', 'false'].map((x) => h('option', {value: x, selected: k.value === x}, x || `default (${k.default})`)))
        : k.kind === 'enum' ? h('select', {on: {change: (e) => apply('setting', {key: k.key, value: e.target.value, typed: true})}}, ['', ...k.choices].map((x) => h('option', {value: x, selected: k.value === x}, x || `default (${k.default})`)))
        : h('input', {type: k.kind === 'number' ? 'number' : 'text', value: k.value, placeholder: k.default === '(not set)' ? '' : `default: ${k.default}`, on: {change: (e) => apply('setting', {key: k.key, value: e.target.value, typed: true})}});
      return h('div.krow', h('div', h('code', k.key), k.set ? h('span.set', 'set') : null, h('div.muted', k.description)), input);
    }));
    draw();
    body = h('div', h('input.search', {type: 'search', placeholder: `Search ${v.advanced.length} settings`, on: {input: (e) => ((q.text = e.target.value.toLowerCase()), draw())}}), h('p.muted', 'Every key in ~/.rein/config.json. Lists are comma-separated; JSON values are written as JSON; empty means the default.'), rows);
  }
  return h('div', tabs, body);
}

/** /model: each section's choices, and the effort for the chat model. */
function modelPanel(c, v) {
  const sec = v.section ?? v.sections[0].id;
  const set = (patch) => {
    c.window = {...c.window, ...patch, name: 'model'};
    renderWindow(c);
  };
  const choose = async (section, value) => {
    try {
      const r = await ask(c, 'model', {section, value});
      toast(r.said);
      set({...r.view, section: sec});
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const s = v.sections.find((x) => x.id === sec);
  return h('div',
    h('div.tabs', v.sections.map((x) => h('button.tab' + (x.id === sec ? '.on' : ''), {on: {click: () => set({section: x.id})}}, x.title))),
    h('p.muted', s.description),
    h('div.options', s.options.map((o) => h('label.opt' + (o.disabled ? '.disabled' : ''), h('input', {type: 'radio', name: `model-${s.id}`, disabled: o.disabled, checked: o.value === s.value, on: {change: () => choose(s.id, o.value)}}), h('span', h('b', o.label), o.hint ? h('small', o.hint) : null)))),
    s.id === 'chat' ? h('div', h('h3', 'Effort'), h('div.options', v.effort.options.map((o) => h('label.opt', h('input', {type: 'radio', name: 'effort', checked: o.value === v.effort.value, on: {change: () => choose('effort', o.value)}}), h('span', h('b', o.label), o.hint ? h('small', o.hint) : null))))) : null,
  );
}

const ADD = [
  ['claude', '', 'Claude subscription', 'Pro / Max'],
  ['claude', 'console', 'Claude API key', 'Anthropic Console, pay per use'],
  ['claude', 'bedrock', 'Claude on Amazon Bedrock', 'your AWS credentials on this machine'],
  ['claude', 'vertex', 'Claude on Google Vertex AI', 'your Google Cloud credentials on this machine'],
  ['codex', '', 'Codex with ChatGPT', 'Plus / Pro / Business'],
  ['codex', 'openai', 'Codex with an OpenAI API key', 'pay per use'],
];
const CLOUD = {
  bedrock: [['region', 'AWS region', 'us-east-1'], ['profile', 'AWS profile (optional)', 'default']],
  vertex: [['projectId', 'Google Cloud project', 'my-project'], ['region', 'Region', 'us-east5']],
};

/** /login: the accounts Rein uses, and adding one through the official CLI's own sign-in, from any device. */
function loginPanel(c, w) {
  const u = (c.winUi ??= {});
  const act = async (op, args = {}) => {
    try {
      const r = await ask(c, op, args);
      if (r && r.name === 'login') ((c.window = r), renderWindow(c));
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const f = w.flow;
  const flow = f ? h('section.setting.flow',
    h('h3', `Signing in: ${f.provider}${f.name ? ` · ${f.name}` : ''}`),
    f.code ? h('div', h('p.muted', 'Open the page below on any device, sign in, and enter this code:'), h('div.devcode', f.code, h('button.btn.small', {on: {click: () => navigator.clipboard?.writeText(f.code).then(() => toast('Code copied'))}}, 'Copy'))) : null,
    f.url ? h('p', h('a.btn.primary', {href: f.url, target: '_blank', rel: 'noopener noreferrer'}, f.code ? 'Open the sign-in page' : 'Sign in'), h('span.muted', {style: {marginLeft: '10px', fontSize: '12.5px'}}, new URL(f.url).host)) : !f.error ? h('p.muted', 'Starting…') : null,
    f.needsCode ? h('div.codein',
      h('p.muted', f.url ? 'After signing in, the page shows a code: paste it here.' : 'Paste the key:'),
      h('input', {type: f.url ? 'text' : 'password', autocomplete: 'off', placeholder: f.url ? 'code' : 'key', on: {input: (e) => (u.code = e.target.value), keydown: (e) => e.key === 'Enter' && act('login-code', {code: u.code})}}),
      h('button.btn.primary', {on: {click: () => act('login-code', {code: u.code})}}, 'Continue'),
    ) : null,
    f.error ? h('div.note.error', f.error) : null,
    h('div.actions', h('button.btn', {on: {click: () => act('login-cancel')}}, f.error ? 'Close' : 'Cancel')),
  ) : null;
  const list = h('div.options', w.accounts.length ? w.accounts.map((a) => h('div.acctrow',
    h('span.dot' + (a.signedIn ? '.ok' : '.bad')),
    h('div.grow', h('b', `${a.provider} `), a.name.startsWith(a.provider) ? a.name.slice(a.provider.length) : a.name, a.plan ? h('span.muted', ` · ${a.plan}`) : null, a.imported ? h('span.muted', ' · imported') : null,
      h('small', a.signedIn ? 'signed in' : `signed out${a.error ? ` (${a.error})` : ''}`)),
    h('button.btn.small', {on: {click: () => act('login-reauth', {id: a.id})}}, 'Re-authenticate'),
    u.remove === a.id
      ? [h('button.btn.small.danger', {on: {click: () => ((u.remove = undefined), act('account-remove', {id: a.id}))}}, a.imported ? 'Unregister' : 'Remove'), h('button.btn.small', {on: {click: () => ((u.remove = undefined), renderWindow(c))}}, 'Keep')]
      : h('button.btn.small', {on: {click: () => ((u.remove = a.id), renderWindow(c))}}, 'Remove'),
  )) : h('p.muted', 'No accounts yet. Add one below.'));
  const add = h('div.addgrid', ADD.map(([provider, api, label, hint]) => {
    const key = `${provider}:${api}`;
    if (u.cloud === key) {
      const vals = (u.cloudVals ??= {});
      return h('div.choice.on.cloud', h('div', h('b', label),
        CLOUD[api].map(([k, l, ph]) => h('label.field', l, h('input', {type: 'text', placeholder: ph, value: vals[k] ?? '', on: {input: (e) => (vals[k] = e.target.value)}}))),
        h('div.actions', h('button.btn.primary', {on: {click: () => ((u.cloud = undefined), act('login-start', {provider, api, apiConfig: vals}))}}, 'Check and add'), h('button.btn', {on: {click: () => ((u.cloud = undefined), renderWindow(c))}}, 'Cancel'))));
    }
    return h('button.choice', {disabled: !!f && !f.error, on: {click: () => (CLOUD[api] ? ((u.cloud = key), (u.cloudVals = {}), renderWindow(c)) : act('login-start', {provider, ...(api ? {api} : {})}))}}, h('div', h('b', `+ ${label}`), h('small', hint)));
  }));
  const jev = h('section.setting',
    h('h3', 'Jev API key'), h('p.muted', w.jev ? 'Set. Jev is a fast, nearly free decision model for auto routing (pick it in /model).' : 'Optional: a fast, nearly free decision model for auto routing, from typesafe.ai.'),
    w.jev ? h('button.btn.small.danger', {on: {click: () => act('jev-remove')}}, 'Remove key') : h('div.codein', h('input', {type: 'password', autocomplete: 'off', placeholder: 'paste key from typesafe.ai', on: {input: (e) => (u.jev = e.target.value)}}), h('button.btn', {on: {click: () => act('jev-set', {key: u.jev})}}, 'Save')),
  );
  return h('div', flow, list, h('h3', 'Add an account'), h('p.muted', 'Sign-in goes through the official claude and codex CLIs on the computer Rein runs on; Rein never sees the tokens.'), add, jev);
}

const when = (ms) => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

/** /rewind: your messages, newest first; pick one, then what to restore. Its text comes back into the box. */
function rewindPanel(c, w) {
  const u = (c.winUi ??= {});
  if (!w.points.length) return h('p.muted', 'Nothing to rewind to yet: rewind goes back to before one of your messages.');
  const pick = async (p, mode) => {
    try {
      const r = await ask(c, 'rewind', {index: p.index, mode});
      if (r.draft !== undefined && c.ui) {
        c.ui.ta.value = r.draft;
        c.ui.ta.dispatchEvent(new Event('input'));
        c.ui.ta.focus();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return h('div.options', w.points.map((p) => {
    const open = u.point === p.index;
    const modes = p.files === 0 && !p.whole ? w.modes.filter((m) => m.mode === 'conversation') : w.modes;
    return h('div.rw' + (open ? '.on' : ''),
      h('button.choice', {on: {click: () => ((u.point = open ? undefined : p.index), renderWindow(c))}}, h('div', h('b', p.text.split('\n')[0].slice(0, 140) || '(empty)'), h('small', `${when(p.at)} · ${p.files ? `${p.files} file${p.files === 1 ? '' : 's'} changed since` : 'no file changes since'}${p.whole ? ' · project snapshot' : ''}`))),
      open ? h('div.rw-modes', modes.map((m) => h('button.btn' + (m.mode === 'both' ? '.primary' : ''), {title: m.hint, on: {click: () => pick(p, m.mode)}}, m.label))) : null,
    );
  }));
}

const shellState = (s) => (s.status === 'running' ? 'running' : s.status === 'exited' ? `exit ${s.exitCode ?? '?'}` : s.status);

/** /shells: the commands you and the agent started; open one for its output (live), stop a running one. */
function shellsPanel(c, w) {
  const u = (c.winUi ??= {});
  if (u.shell === undefined && w.open !== undefined) u.shell = w.open;
  if (!w.shells.length) return h('p.muted', 'No shells yet: commands the agent runs (and your !commands) show here.');
  const out = h('pre.text.shell-out', '…');
  if (u.shell !== undefined)
    ask(c, 'shell', {id: u.shell}).then((sh) => {
      out.textContent = sh.output || '(no output)';
      out.scrollTop = out.scrollHeight;
    }, (err) => (out.textContent = err.message));
  return h('div.split',
    h('div.split-list', w.shells.slice().reverse().map((sh) => h('button.choice' + (u.shell === sh.id ? '.on' : ''), {on: {click: () => ((u.shell = sh.id), renderWindow(c))}},
      h('span.dot' + (sh.status === 'running' ? '.busy' : sh.status === 'exited' && sh.exitCode === 0 ? '.ok' : '.bad')),
      h('div', h('code', sh.command.length > 80 ? sh.command.slice(0, 80) + '…' : sh.command), h('small', `#${sh.id} · ${shellState(sh)} · ${sh.origin === 'agent' ? 'the agent' : 'you'}${sh.background ? ' · background' : ''} · ${when(sh.startedAt)}`))))),
    u.shell !== undefined ? h('div.split-main',
      out,
      w.shells.find((x) => x.id === u.shell)?.status === 'running' ? h('div.actions', h('button.btn.danger', {on: {click: () => ask(c, 'shell-kill', {id: u.shell}).catch((e) => toast(e.message, 'error'))}}, 'Stop it')) : null,
    ) : h('div.split-main', h('p.muted', 'Pick a shell to see its output.')),
  );
}

/** /agents: the conversation's subagents; open one to follow it, message it, or stop it. */
function agentsPanel(c, w) {
  const u = (c.winUi ??= {});
  if (!w.agents.length) return h('p.muted', 'No subagents yet: the agent starts them with its agent tool.');
  const view = h('div.agent-log', h('p.muted', 'Pick a subagent to follow it.'));
  const draw = (a) => view.replaceChildren(
    h('div.muted', a.task),
    ...a.events.map((e) => e.kind === 'text' ? md(e.text) : e.kind === 'tool' ? toolEl({...e, pending: e.ok === undefined}) : e.kind === 'user' ? h('div.msg.user', h('div.bubble', e.text)) : h('div.note', e.kind === 'check' ? `${e.complete ? '✓' : '…'} ${e.note}` : e.text)),
    ...(a.error ? [h('div.note.error', a.error)] : []),
  );
  if (u.agent !== undefined) ask(c, 'agent', {id: u.agent}).then(draw, (err) => view.replaceChildren(h('div.note.error', err.message)));
  const chosen = w.agents.find((a) => a.id === u.agent);
  const msg = h('textarea', {rows: 2, placeholder: chosen ? `Message ${chosen.name}` : ''});
  if (u.draft) msg.value = u.draft;
  msg.addEventListener('input', () => (u.draft = msg.value));
  const sendMsg = async () => {
    const text = msg.value.trim();
    if (!text) return;
    try {
      u.draft = '';
      msg.value = '';
      draw(await ask(c, 'agent-message', {id: u.agent, text}));
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  msg.addEventListener('keydown', (e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void sendMsg()));
  msg.addEventListener('blur', () => c.windowStale && ((c.windowStale = false), renderWindow(c)));
  return h('div.split',
    h('div.split-list', w.agents.map((a) => h('button.choice' + (u.agent === a.id ? '.on' : ''), {on: {click: () => ((u.agent = a.id), renderWindow(c))}},
      h('span.dot' + (a.status === 'running' ? '.busy' : a.status === 'done' ? '.ok' : a.status === 'failed' ? '.bad' : '')),
      h('div', h('b', a.name), h('small', `#${a.id} · ${a.model} · ${a.mode} · ${a.status}${a.background ? ' · background' : ''}`))))),
    chosen ? h('div.split-main', view, h('div.agent-send', msg, h('button.btn.primary', {on: {click: sendMsg}}, 'Send'), chosen.status === 'running' ? h('button.btn.danger', {on: {click: () => ask(c, 'agent-stop', {id: chosen.id}).catch((e) => toast(e.message, 'error'))}}, 'Stop') : null)) : h('div.split-main', view),
  );
}

function plansPanel(c, v) {
  if (!v.plans.length) return h('div', h('p.muted', 'No unfinished plans in .rein/plans yet.'), h('button.btn', {on: {click: () => (closeWindow(c), (c.ui.ta.value = '/plan '), c.ui.ta.focus())}}, 'Write a new plan'));
  return h('div.options', v.plans.map((p) => h('button.choice', {on: {click: async () => {
    closeWindow(c);
    await ask(c, 'plan-goal', {file: p.file}).catch((e) => toast(e.message, 'error'));
  }}}, h('div', h('b', p.title), h('small', `${p.done}/${p.total} milestones done`)))), h('button.btn', {on: {click: () => (closeWindow(c), (c.ui.ta.value = '/plan '), c.ui.ta.focus())}}, 'Write a new plan'));
}

// ---------- files ----------

async function openFolder(dir) {
  const f = state.files;
  try {
    const r = await api(`/api/fs/list?path=${encodeURIComponent(dir)}${f.hidden ? '&hidden=1' : ''}`);
    Object.assign(f, {path: r.path, parent: r.parent, entries: r.entries, sel: new Set(), results: undefined, search: ''});
  } catch (err) {
    toast(err.message, 'error');
  }
  if (state.view === 'files') render();
}
const refresh = () => openFolder(state.files.path);

function sorted(entries) {
  const f = state.files;
  const k = f.sort;
  return [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || f.dir * (k === 'size' ? a.size - b.size : k === 'modified' ? a.modified - b.modified : a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'})));
}

function fileIcon(e) {
  if (e.dir) return '📁';
  const x = e.name.split('.').pop().toLowerCase();
  return /^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(x) ? '🖼' : /^(mp4|webm|mov|mkv)$/.test(x) ? '🎞' : /^(mp3|wav|flac|ogg|m4a)$/.test(x) ? '🎵' : /^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(x) ? '🗜' : x === 'pdf' ? '📕' : /^(md|txt|rst)$/.test(x) ? '📝' : '📄';
}

async function preview(entry) {
  const f = state.files;
  const x = entry.name.split('.').pop().toLowerCase();
  const raw = `/api/fs/raw?path=${encodeURIComponent(entry.path)}`;
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(x)) f.preview = {entry, kind: 'image', src: raw};
  else if (/^(mp4|webm|mov)$/.test(x)) f.preview = {entry, kind: 'video', src: raw};
  else if (/^(mp3|wav|ogg|m4a|flac)$/.test(x)) f.preview = {entry, kind: 'audio', src: raw};
  else if (x === 'pdf') f.preview = {entry, kind: 'pdf', src: raw};
  else {
    try {
      const r = await api(`/api/fs/read?path=${encodeURIComponent(entry.path)}`);
      f.preview = r.text !== undefined ? {entry, kind: 'text', text: r.text, saved: r.text} : {entry, kind: 'other', note: r.tooBig ? `${fmtSize(r.size)}: too large to show here.` : "This isn't a text file."};
    } catch (err) {
      return toast(err.message, 'error');
    }
  }
  render();
}

function previewEl() {
  const p = state.files.preview;
  const close = h('button.icon-btn', {title: 'Close', on: {click: () => ((state.files.preview = undefined), render())}}, icon('x'));
  const dl = h('a.btn.small', {href: `/api/fs/raw?path=${encodeURIComponent(p.entry.path)}&download=1`}, icon('download', 14), 'Download');
  if (p.kind === 'text') {
    const ta = h('textarea', {spellcheck: false, value: p.text, on: {input: (e) => {
      p.text = e.target.value;
      save.disabled = p.text === p.saved;
    }, keydown: (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') (e.preventDefault(), doSave());
      if (e.key === 'Tab') {
        e.preventDefault();
        const t = e.target;
        const [a, b] = [t.selectionStart, t.selectionEnd];
        t.value = t.value.slice(0, a) + '  ' + t.value.slice(b);
        t.selectionStart = t.selectionEnd = a + 2;
        t.dispatchEvent(new Event('input'));
      }
    }}});
    const doSave = async () => {
      try {
        await api('/api/fs/write', {body: {path: p.entry.path, text: p.text}});
        p.saved = p.text;
        save.disabled = true;
        toast(`Saved ${p.entry.name}`);
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    const save = h('button.btn.small.primary', {disabled: true, on: {click: doSave}}, 'Save');
    return h('div.preview', h('div.ph', h('span.t', p.entry.name), save, dl, close), ta);
  }
  const body = p.kind === 'image' ? h('img', {src: p.src, alt: p.entry.name}) : p.kind === 'video' ? h('video', {src: p.src, controls: true}) : p.kind === 'audio' ? h('audio', {src: p.src, controls: true}) : p.kind === 'pdf' ? h('iframe', {src: p.src, title: p.entry.name}) : h('div.muted', p.note);
  return h('div.preview', h('div.ph', h('span.t', p.entry.name), dl, close), h('div.pv', body));
}

async function act(kind, entries) {
  const f = state.files;
  try {
    if (kind === 'rename') {
      const e = entries[0];
      const name = prompt('New name', e.name);
      if (!name || name === e.name) return;
      await api('/api/fs/move', {body: {from: e.path, to: join(f.path, name)}});
    } else if (kind === 'move' || kind === 'copy') {
      return folderPicker({title: `${kind === 'move' ? 'Move' : 'Copy'} ${entries.length === 1 ? entries[0].name : `${entries.length} items`} to…`, start: f.path, action: kind === 'move' ? 'Move here' : 'Copy here', onPick: async (dir) => {
        try {
          for (const e of entries) await api(`/api/fs/${kind}`, {body: {from: e.path, to: join(dir, e.name)}});
          toast(`${kind === 'move' ? 'Moved' : 'Copied'} ${entries.length} item${entries.length > 1 ? 's' : ''}`);
        } catch (err) {
          toast(err.message, 'error');
        }
        await refresh();
      }});
    } else if (kind === 'delete') {
      if (!confirm(`Delete ${entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`}? This can't be undone.`)) return;
      await api('/api/fs/delete', {body: {paths: entries.map((e) => e.path)}});
      toast(`Deleted ${entries.length} item${entries.length > 1 ? 's' : ''}`);
      if (f.preview && entries.some((e) => e.path === f.preview.entry.path)) f.preview = undefined;
    } else if (kind === 'mkdir') {
      const name = prompt('New folder name');
      if (!name) return;
      await api('/api/fs/mkdir', {body: {path: join(f.path, name)}});
    } else if (kind === 'newfile') {
      const name = prompt('New file name');
      if (!name) return;
      await api('/api/fs/write', {body: {path: join(f.path, name), text: ''}});
    } else if (kind === 'project') {
      await api('/api/projects', {body: {path: entries[0].path}});
      await loadProjects();
      setProject(entries[0].path);
      return go('#/chat');
    } else if (kind === 'chat') {
      await api('/api/projects', {body: {path: entries[0].path}});
      await loadProjects();
      setProject(entries[0].path);
      return newChat(entries[0].path);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
  await refresh();
}

function uploadFiles(fileList) {
  const f = state.files;
  const box = $('.uploads') ?? document.body.appendChild(h('div.uploads'));
  for (const file of fileList) {
    const row = h('div', h('div', file.name), h('div.bar', h('i', {style: {width: '0%'}})));
    box.append(row);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/fs/upload?dir=${encodeURIComponent(f.path)}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Rein', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && ($('i', row).style.width = `${Math.round((e.loaded / e.total) * 100)}%`);
    xhr.onload = () => {
      if (xhr.status >= 300) toast(`${file.name}: ${JSON.parse(xhr.responseText || '{}').error ?? xhr.status}`, 'error');
      row.remove();
      if (!box.children.length) box.remove();
      void refresh();
    };
    xhr.onerror = () => (toast(`${file.name}: upload failed`, 'error'), row.remove());
    xhr.send(file);
  }
}

function filesView() {
  const f = state.files;
  // Under your home folder the trail starts at ~.
  const underHome = state.home && (f.path === state.home || f.path.startsWith(state.home + sep()));
  const rest = underHome ? f.path.slice(state.home.length).replace(/^[\\/]/, '') : f.path;
  const parts = [...(underHome ? ['~' + sep()] : []), ...(rest ? rest.split(/(?<=[\\/])/).filter(Boolean) : [])];
  let acc = '';
  const crumbs = h('div.crumbs', parts.map((part, i) => {
    acc += part === '~' + sep() ? state.home + sep() : part;
    const target = acc.length > 1 ? acc.replace(/[\\/]$/, '') || acc : acc;
    return [i ? h('span.sep', '›') : null, h('button', {on: {click: () => go(`#/files?path=${encodeURIComponent(target)}`)}}, part.replace(/[\\/]$/, '') || part)];
  }));
  const items = f.results ? f.results.map((r) => ({name: tilde(r.path) + (r.line ? `:${r.line}` : ''), path: r.path, dir: false, size: 0, modified: 0, text: r.text})) : sorted(f.entries);
  const selected = () => items.filter((e) => f.sel.has(e.path));
  const open = (e) => (e.dir ? go(`#/files?path=${encodeURIComponent(e.path)}`) : void preview(e));
  const rowMenu = (ev, e) => {
    if (!f.sel.has(e.path)) (f.sel = new Set([e.path]), render());
    const sel = selected().length ? selected() : [e];
    menu(ev, [
      [e.dir ? 'Open' : 'Preview', () => open(e)],
      e.dir ? ['Open as a project', () => act('project', [e])] : null,
      e.dir ? ['New chat in this folder', () => act('chat', [e])] : null,
      !e.dir ? ['Download', () => (location.href = `/api/fs/raw?path=${encodeURIComponent(e.path)}&download=1`)] : null,
      null,
      sel.length === 1 ? ['Rename', () => act('rename', sel)] : null,
      ['Move to…', () => act('move', sel)],
      ['Copy to…', () => act('copy', sel)],
      null,
      ['Delete', () => act('delete', sel), 'danger'],
    ].filter((x, i, a) => x !== null || (a[i - 1] !== null && i > 0)));
  };
  const th = (key, label, cls) => h('th' + (cls ? '.' + cls : ''), {on: {click: () => ((f.dir = f.sort === key ? -f.dir : 1), (f.sort = key), render())}}, label, f.sort === key ? (f.dir > 0 ? ' ↑' : ' ↓') : '');
  const table = h('table',
    h('thead', h('tr', h('th', {style: {width: '28px'}}, h('input', {type: 'checkbox', checked: items.length && f.sel.size === items.length, on: {change: (e) => ((f.sel = new Set(e.target.checked ? items.map((x) => x.path) : [])), render())}})), th('name', 'Name'), th('size', 'Size', 'hide-sm'), th('modified', 'Modified', 'hide-sm'), h('th', ''))),
    h('tbody', items.map((e) => h('tr' + (f.sel.has(e.path) ? '.sel' : ''), {
      on: {
        dblclick: () => open(e),
        click: (ev) => {
          if (ev.target.closest('input,button')) return;
          if (ev.metaKey || ev.ctrlKey) f.sel.has(e.path) ? f.sel.delete(e.path) : f.sel.add(e.path);
          else if (innerWidth < 820) return open(e);
          else f.sel = new Set([e.path]);
          render();
        },
        contextmenu: (ev) => (ev.preventDefault(), rowMenu(ev, e)),
      },
    },
      h('td', h('input', {type: 'checkbox', checked: f.sel.has(e.path), on: {change: (ev) => ((ev.target.checked ? f.sel.add(e.path) : f.sel.delete(e.path)), render())}})),
      h('td', h('div.fname', h('span.ico', fileIcon(e)), h('span', {title: e.path}, e.name), e.text ? h('span.muted.mono', {style: {fontSize: '12px'}}, e.text) : null)),
      h('td.num.hide-sm', e.dir ? '' : fmtSize(e.size)),
      h('td.when.hide-sm', e.modified ? ago(e.modified) : ''),
      h('td', h('button.icon-btn', {title: 'Actions', on: {click: (ev) => rowMenu(ev, e)}}, icon('more', 16))),
    ))),
  );
  const list = h('div.flist', table, !items.length ? h('div.muted', {style: {padding: '24px', textAlign: 'center'}}, f.results ? 'Nothing found.' : 'This folder is empty. Drop files here to upload them.') : null);
  // Drag and drop to upload.
  let depth = 0;
  list.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    if (depth++ === 0) list.append(h('div.drop', `Drop to upload to ${base(f.path)}`));
  });
  list.addEventListener('dragover', (e) => e.preventDefault());
  list.addEventListener('dragleave', () => --depth === 0 && $('.drop', list)?.remove());
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('.drop', list)?.remove();
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  const picker = h('input', {type: 'file', multiple: true, class: 'hidden', on: {change: (e) => uploadFiles(e.target.files)}});
  const sel = selected();
  const search = h('input', {type: 'search', placeholder: 'Search here…', value: f.search, style: {width: '220px'}, on: {keydown: async (e) => {
    if (e.key !== 'Enter') return;
    f.search = e.target.value;
    if (!f.search.trim()) return ((f.results = undefined), render());
    try {
      f.results = (await api(`/api/fs/search?path=${encodeURIComponent(f.path)}&q=${encodeURIComponent(f.search)}${f.content ? '&content=1' : ''}${f.hidden ? '&hidden=1' : ''}`)).results;
    } catch (err) {
      toast(err.message, 'error');
    }
    render();
  }}});
  return h('main.main',
    topbar('Files'),
    h('div.files',
      h('div.fbar',
        h('button.icon-btn', {title: 'Up', disabled: !f.parent, on: {click: () => f.parent && go(`#/files?path=${encodeURIComponent(f.parent)}`)}}, icon('up')),
        crumbs,
        search,
        h('label', {style: {fontSize: '13px', display: 'flex', gap: '4px', alignItems: 'center'}}, h('input', {type: 'checkbox', checked: !!f.content, on: {change: (e) => (f.content = e.target.checked)}}), 'in files'),
      ),
      h('div.fbar',
        h('button.btn.small', {on: {click: () => picker.click()}}, icon('upload', 14), 'Upload'),
        h('button.btn.small', {on: {click: () => act('mkdir')}}, icon('newfolder', 14), 'New folder'),
        h('button.btn.small', {on: {click: () => act('newfile')}}, icon('file', 14), 'New file'),
        h('button.btn.small', {on: {click: () => act('chat', [{path: f.path}])}}, icon('chat', 14), 'New chat here'),
        sel.length ? [h('span.muted', {style: {fontSize: '13px'}}, `${sel.length} selected`), h('button.btn.small', {on: {click: () => act('move', sel)}}, 'Move'), h('button.btn.small', {on: {click: () => act('copy', sel)}}, 'Copy'), h('button.btn.small.danger', {on: {click: () => act('delete', sel)}}, 'Delete')] : null,
        h('span', {style: {flex: '1'}}),
        h('label', {style: {fontSize: '13px', display: 'flex', gap: '4px', alignItems: 'center'}}, h('input', {type: 'checkbox', checked: f.hidden, on: {change: (e) => ((f.hidden = e.target.checked), refresh())}}), 'Hidden files'),
        h('button.icon-btn', {title: 'Refresh', on: {click: refresh}}, icon('refresh', 16)),
        picker,
      ),
      h('div.fbody' + (f.preview ? '.with-preview' : ''), list, f.preview ? previewEl() : null),
    ),
  );
}

// ---------- settings ----------

function settingsView() {
  const theme = localStorage.getItem('rein.theme') ?? 'system';
  const pw = {current: '', next: ''};
  return h('main.main', topbar('Settings'), h('div.scroll', h('div.settings',
    h('section', h('h2', 'Appearance'), h('div', ['system', 'light', 'dark'].map((t) => h('label', {style: {marginRight: '16px'}}, h('input', {type: 'radio', name: 'theme', checked: theme === t, on: {change: () => (localStorage.setItem('rein.theme', t), applyTheme())}}), ` ${t[0].toUpperCase()}${t.slice(1)}`)))),
    h('section', h('h2', 'Access'),
      h('p.muted', state.mode === 'local' ? 'Only this computer: Rein listens on localhost, with no login.' : state.mode === 'tailscale' ? 'Your devices through Tailscale: Rein listens on localhost and your tailnet reaches it (tailscale serve), with no login.' : `Signed in as ${state.me}. Rein listens on the network and asks everyone to sign in.`),
      state.mode === 'password' ? h('div',
        h('label.field', 'Current password'), h('input', {type: 'password', autocomplete: 'current-password', on: {input: (e) => (pw.current = e.target.value)}}),
        h('label.field', 'New password'), h('input', {type: 'password', autocomplete: 'new-password', on: {input: (e) => (pw.next = e.target.value)}}),
        h('div', {style: {display: 'flex', gap: '8px', marginTop: '12px'}},
          h('button.btn.primary', {on: {click: async () => {
            try {
              await api('/api/password', {body: {current: pw.current, password: pw.next}});
              toast('Password changed. Other devices are signed out.');
            } catch (err) {
              toast(err.message, 'error');
            }
          }}}, 'Change password'),
          h('button.btn', {on: {click: async () => {
            await api('/api/logout', {body: {}});
            location.reload();
          }}}, 'Sign out'),
        ),
      ) : null,
      h('p.muted', {style: {fontSize: '13px'}}, 'To change how Rein is reached, delete ~/.rein/webui.json on this computer and restart rein --ui: the setup runs again.'),
    ),
    h('section', h('h2', 'Rein'),
      h('p.muted', 'Models, approvals, the status line and sidebar, and every other setting: the same window as /settings and /model in a chat.'),
      h('div', {style: {display: 'flex', gap: '8px'}},
        h('button.btn.primary', {disabled: !state.chat, on: {click: () => (go(`#/chat/${state.chat.id}`), runInChat(state.chat, '/settings'))}}, 'Open settings'),
        h('button.btn', {disabled: !state.chat, on: {click: () => (go(`#/chat/${state.chat.id}`), runInChat(state.chat, '/model'))}}, 'Models'),
      ),
      !state.chat ? h('p.muted', {style: {fontSize: '13px'}}, 'Open a chat first: settings are read and saved by Rein in that chat.') : null,
    ),
    h('section', h('h2', 'About'), h('p.muted', `Rein ${state.version}. Accounts are signed in from Rein's terminal (rein, then /login); the web UI uses the same ones.`)),
  )));
}

// Crossing the wide/narrow line moves the chat's sidebar between beside and over the chat.
let wasWide = innerWidth >= 1100;
addEventListener('resize', () => {
  const wide = innerWidth >= 1100;
  if (wide !== wasWide && state.view === 'chat') ((wasWide = wide), (state.panelShow = false), render());
});

void boot();
