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
  menu: 'M4 6h16M4 12h16M4 18h16', up: 'M12 19V5M5 12l7-7 7 7', upload: 'M12 16V4M6 10l6-6 6 6M4 20h16', refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7', search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5', more: 'M5 12h.01M12 12h.01M19 12h.01', x: 'M6 6l12 12M18 6L6 18', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', download: 'M12 4v12M6 10l6 6 6-6M4 20h16', newfolder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6',
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
    Object.assign(state, {setup: s.setup, mode: s.mode, me: s.user, home: s.home, platform: s.platform, version: s.version});
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
  await loadProjects();
  if (!state.project && state.projects[0]) state.project = state.projects[0].path;
  await loadChats();
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

async function loadProjects() {
  state.projects = (await api('/api/projects')).projects;
}
async function loadChats() {
  state.chats = await api(`/api/chats${state.project ? `?project=${encodeURIComponent(state.project)}` : ''}`);
}
function setProject(p) {
  state.project = p;
  localStorage.setItem('rein.project', p);
  void loadChats().then(render);
}

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
  const proj = state.projects.find((p) => p.path === state.project);
  const openIds = new Set(state.chats.open.map((c) => c.session).filter(Boolean));
  const chatBtn = (c, saved) =>
    h('button.side-item' + (state.view === 'chat' && state.chat && (state.chat.id === c.id || state.chat.snapshot?.session === c.session) ? '.active' : ''), {
      on: {click: () => (saved ? void openSaved(c.session) : go(`#/chat/${c.id}`))},
      title: c.title,
    }, h('span.dot' + (c.waiting ? '.wait' : c.busy ? '.busy' : '')), h('span.t', c.title || 'New chat'), saved ? h('span.meta', ago(c.updatedAt)) : null);
  return h('aside.side',
    h('div.side-top',
      h('div.brand', h('img', {src: '/icon.svg', alt: ''}), 'Rein'),
      h('button.project-btn', {on: {click: pickProject}, title: state.project}, icon('folder', 16), h('span.t', proj?.name ?? (state.project ? base(state.project) : 'Open a project…'), state.project ? h('span.p', tilde(state.project)) : null)),
      h('button.btn.primary', {disabled: !state.project, on: {click: newChat}}, icon('plus', 16), 'New chat'),
    ),
    h('div.side-scroll',
      state.chats.open.length ? [h('div.side-label', 'Open'), state.chats.open.map((c) => chatBtn(c, false))] : null,
      h('div.side-label', 'Recent'),
      state.chats.saved.filter((s) => !openIds.has(s.session)).slice(0, 60).map((s) => chatBtn(s, true)),
      !state.chats.saved.length && !state.chats.open.length ? h('div.muted', {style: {padding: '6px 9px', fontSize: '13px'}}, state.project ? 'No conversations here yet.' : 'Open a project to start.') : null,
    ),
    h('div.side-bottom',
      h('button.side-item' + (state.view === 'files' ? '.active' : ''), {on: {click: () => go(`#/files?path=${encodeURIComponent(state.project || state.home)}`)}}, icon('folder', 16), h('span.t', 'Files')),
      h('button.side-item' + (state.view === 'settings' ? '.active' : ''), {on: {click: () => go('#/settings')}}, icon('gear', 16), h('span.t', 'Settings')),
    ),
  );
}

const topbar = (title, extra = []) => h('div.topbar', h('button.icon-btn.menu-btn', {on: {click: () => ((state.sideOpen = true), render())}, 'aria-label': 'Menu'}, icon('menu')), h('div.title', title), ...extra);

// ---------- projects ----------

function pickProject() {
  folderPicker({title: 'Open a project', start: state.project || state.home, recent: state.projects, onPick: async (dir) => {
    await api('/api/projects', {body: {path: dir}});
    await loadProjects();
    setProject(dir);
    go('#/chat');
  }});
}

/** A dialog to choose a folder: recent projects, then a browser of this machine. */
function folderPicker({title, start, recent = [], onPick, action = 'Open'}) {
  let cwd = start;
  let entries = [];
  const list = h('div', {style: {maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '10px'}});
  const pathInput = h('input', {type: 'text', value: tilde(cwd), on: {keydown: (e) => e.key === 'Enter' && load(e.target.value)}});
  const load = async (dir) => {
    try {
      const r = await api(`/api/fs/list?path=${encodeURIComponent(dir)}`);
      cwd = r.path;
      entries = r.entries.filter((e) => e.dir);
      pathInput.value = tilde(cwd);
      list.replaceChildren(
        r.parent ? h('button.side-item', {on: {click: () => load(r.parent)}}, icon('up', 16), h('span.t', '..')) : null,
        entries.map((e) => h('button.side-item', {on: {click: () => load(e.path), dblclick: () => done(e.path)}}, icon('folder', 16), h('span.t', e.name))),
        !entries.length ? h('div.muted', {style: {padding: '10px'}}, 'No folders here.') : null,
      );
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const ov = h('div.overlay', {on: {click: (e) => e.target === ov && ov.remove()}});
  const done = (dir) => {
    ov.remove();
    onPick(dir);
  };
  ov.append(h('div.dialog',
    h('header', title),
    h('div.body',
      recent.length ? [h('div.side-label', 'Recent projects'), recent.slice(0, 8).map((p) => h('button.side-item', {on: {click: () => done(p.path)}}, icon('folder', 16), h('span.t', p.name), h('span.meta', tilde(p.path))))] : null,
      h('div.side-label', 'Browse'),
      pathInput,
      h('div', {style: {height: '8px'}}),
      list,
    ),
    h('footer', h('button.btn', {on: {click: () => ov.remove()}}, 'Cancel'), h('button.btn.primary', {on: {click: () => done(cwd)}}, `${action} this folder`)),
  ));
  document.body.append(ov);
  void load(cwd);
}

// ---------- chats ----------

async function newChat() {
  if (!state.project) return pickProject();
  try {
    toast('Starting a chat…');
    const r = await api('/api/chats', {body: {project: state.project}});
    await loadChats();
    go(`#/chat/${r.id}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}
async function openSaved(session) {
  try {
    const r = await api('/api/chats', {body: {project: state.project, resume: session}});
    await loadChats();
    go(`#/chat/${r.id}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Watch a chat: a snapshot, then live events (server-sent). */
function attachChat(id) {
  if (!/^[\da-f]{16}$/.test(id)) return;
  state.chat?.es?.close();
  const c = {id, snapshot: undefined, live: '', tools: [], asks: new Map(), busy: false, notes: [], model: undefined, es: undefined, stick: true};
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
      c.busy = ev.snapshot.busy;
      if (!c.busy) Object.assign(c, {live: '', tools: [], notes: [], model: undefined});
      void loadChats().then(() => state.view === 'chat' && renderSide());
      break;
    case 'busy':
      c.busy = ev.busy;
      if (ev.phrase) c.phrase = ev.phrase;
      if (ev.busy) Object.assign(c, {live: '', tools: [], notes: [], model: undefined});
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
    const bar = $('#composer-wrap');
    if (bar) bar.replaceWith(composer());
    const title = $('.topbar .title');
    if (title && state.chat?.snapshot) title.textContent = state.chat.snapshot.title;
    if (scroll && stick) scroll.scrollTop = scroll.scrollHeight;
  });
}
function renderSide() {
  const side = $('.side');
  if (side) side.replaceWith(sidebar());
}

function toolEl(t) {
  const status = t.pending ? 'busy' : t.ok === false ? 'bad' : 'ok';
  const d = h('details.tool', h('summary', h('span.dot.' + status), h('span.name', t.label), h('span.arg', t.summary)));
  if (t.diff?.length) d.append(h('div.diff', t.diff.map((l) => h('div.' + l.kind, (l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  ') + l.text))));
  if (t.result) d.append(h('pre.out', t.result));
  if (t.warning) d.append(h('div.note', {style: {padding: '0 12px 8px'}}, '⚠ ' + t.warning));
  return d;
}

function messageEl(m) {
  if (m.role === 'user') return h('div.msg.user', h('div.bubble', m.text));
  return h('div.msg.assistant', (m.tools ?? []).map(toolEl), m.text ? md(m.text) : null, m.interrupted ? h('div.note', 'Interrupted.') : null);
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
  return h('div.ask', h('h3', 'Rein needs you'), h('pre', JSON.stringify(a.payload, null, 2)));
}

function threadEl() {
  const c = state.chat;
  const s = c?.snapshot;
  if (!s) return h('div.thread#thread', h('div.note', 'Starting…'));
  if (!s.messages.length && !c.busy && !c.live) {
    const hour = new Date().getHours();
    return h('div.thread#thread', h('div.empty', h('h1', hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'), h('p', `What should we do in ${base(s.cwd)}?`)));
  }
  // The turn in progress: the reply so far with its tool calls where they happened.
  const live = [];
  if (c.busy || c.live || c.tools.length) {
    let at = 0;
    for (const t of c.tools) {
      if (t.after > at) live.push(md(c.live.slice(at, t.after)));
      at = Math.max(at, t.after);
      live.push(toolEl(t));
    }
    if (c.live.length > at) live.push(md(c.live.slice(at)));
  }
  return h('div.thread#thread',
    s.messages.map(messageEl),
    live.length ? h('div.msg.assistant', live) : null,
    c.notes.map((n) => h('div.note' + (n.error ? '.error' : ''), n.text)),
    [...c.asks.values()].map((a) => askEl(c, a)),
  );
}

function composer() {
  const c = state.chat;
  const s = c?.snapshot;
  const ta = h('textarea', {rows: 1, placeholder: c?.busy ? 'The agent is working…' : 'Message Rein', on: {
    input: (e) => {
      e.target.style.height = 'auto';
      e.target.style.height = `${e.target.scrollHeight}px`;
      sendBtn.disabled = !e.target.value.trim() || c?.busy;
    },
    keydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void send();
      }
    },
  }});
  if (c?.draft) ta.value = c.draft;
  ta.addEventListener('input', () => c && (c.draft = ta.value));
  const send = async () => {
    const text = ta.value.trim();
    if (!text || !c || c.busy) return;
    c.draft = '';
    ta.value = '';
    c.snapshot = {...c.snapshot, messages: [...c.snapshot.messages, {role: 'user', text, at: Date.now()}]};
    c.busy = true;
    scheduleThread();
    try {
      await api(`/api/chats/${c.id}/send`, {body: {text}});
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const sendBtn = h('button.send', {disabled: true, title: 'Send (Enter)', on: {click: send}}, icon('send', 17));
  const stopBtn = h('button.send.stop', {title: 'Stop', on: {click: () => api(`/api/chats/${c.id}/interrupt`, {body: {}}).catch((e) => toast(e.message, 'error'))}}, icon('stop', 15));
  const model = h('select', {title: 'Model', disabled: !s, on: {change: (e) => api(`/api/chats/${c.id}/model`, {body: {model: e.target.value}}).catch((x) => toast(x.message, 'error'))}},
    h('option', {value: 'auto', selected: s?.chatModel === 'auto'}, 'Auto'),
    (s?.models ?? []).map((m) => h('option', {value: m.ref, selected: s.chatModel === m.ref}, `${m.label} · ${m.provider === 'claude' ? 'Claude' : 'Codex'}`)),
  );
  const mode = h('select', {title: 'Approvals', disabled: !s, on: {change: (e) => api(`/api/chats/${c.id}/mode`, {body: {mode: e.target.value}}).catch((x) => toast(x.message, 'error'))}},
    [['ask', 'Ask before changes'], ['auto', 'Auto-approve'], ['bypass', 'Allow everything'], ['plan', 'Plan only']].map(([v, l]) => h('option', {value: v, selected: s?.mode === v}, l)),
  );
  return h('div.composer-wrap#composer-wrap',
    c?.busy ? h('div.working', h('span.dot.busy'), c.asks.size ? 'Waiting for you' : `${c.phrase ?? 'Thinking'}…${c.model ? ` · ${c.model}` : ''}`) : null,
    h('div.composer', ta, h('div.row', model, mode, h('span.spacer'), c?.busy ? stopBtn : sendBtn)),
  );
}

function chatView() {
  const c = state.chat;
  if (!c) {
    return h('main.main', topbar(state.project ? base(state.project) : 'Rein', state.project ? [h('span.path', tilde(state.project))] : []), h('div.scroll', h('div.empty', h('h1', 'Rein'), h('p', state.project ? `Start a chat in ${base(state.project)}, or pick one on the left.` : 'Open a project folder to start.'), h('button.btn.primary', {on: {click: state.project ? newChat : pickProject}}, state.project ? 'New chat' : 'Open a project'))));
  }
  const s = c.snapshot;
  return h('main.main',
    topbar(s?.title ?? 'Chat', [s ? h('span.path', tilde(s.cwd)) : null, h('button.icon-btn', {title: 'More', on: {click: (e) => chatMenu(e, c)}}, icon('more'))]),
    h('div.scroll', threadEl()),
    composer(),
  );
}
function afterChatRender() {
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
      return newChat();
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
    h('section', h('h2', 'About'), h('p.muted', `Rein ${state.version}. Accounts and models are managed in Rein's terminal (rein, then /login and /model); the web UI uses the same ones.`)),
  )));
}

void boot();
