import readline from 'node:readline';
import type {EngineEvent} from '../session/engine.js';
import type {Message} from '../session/transcript.js';
import {pickPhrase} from '../ui/phrases.js';
import type {Overlay} from '../ui/useRein.js';
import {approvalNote, routeLabel, toolResultSummary} from '../ui/format.js';

/**
 * One web UI chat (`rein --ui-worker`, started by the server in the project's folder): Rein's
 * runtime and engine, as in the terminal, talking newline JSON over stdin/stdout. The server sends
 * init / send / interrupt / answer / model / mode / compact; this sends ready, events, asks
 * (approvals, questions, plans) and a fresh snapshot after each turn.
 */
/** `brief`: the one-line result the terminal shows under the call; `note`: how it was approved. */
export type ToolView = {label: string; summary: string; ok?: boolean; result?: string; brief?: string; note?: string; diff?: {kind: string; n?: number; text: string}[]};
export type MessageView = {role: 'user' | 'assistant'; text: string; at: number; model?: string; tools?: ToolView[]; interrupted?: boolean};
export type Snapshot = {
  session: string;
  cwd: string;
  title: string;
  messages: MessageView[];
  models: {ref: string; label: string; provider: string}[];
  chatModel: string;
  mode: 'ask' | 'auto' | 'bypass' | 'plan';
  busy: boolean;
  /** Things with a screen the agent made (preview/registry.ts), and whether each is open. */
  previews: {id: number; kind: string; target: string; title: string; source: string; open: boolean; url?: string; remote?: boolean}[];
  /** The accent of a theme from a marketplace item or your theme setting (a CSS color), if any. */
  accent?: string;
  /** The status line and sidebar, as /settings lays them out (panels.ts). */
  status: StatusSegment[];
  sidebar: SidebarSection[];
  /** Messages typed while the agent was working, run after it finishes. */
  queued: string[];
};
type StatusSegment = ReturnType<typeof import('./panels.js').statusView>[number];
type SidebarSection = import('./panels.js').SidebarSection;

const safeRoute = (ev: Extract<EngineEvent, {type: 'route'}>) => {
  try {
    return routeLabel(ev.route, ev.account, ev.effort);
  } catch {
    return undefined;
  }
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

export function messageView(m: Message): MessageView {
  return {
    role: m.role,
    text: m.text,
    at: m.at,
    ...(m.model ? {model: `${m.model.provider}:${m.model.model}`} : {}),
    ...(m.interrupted ? {interrupted: true} : {}),
    ...(m.tools?.length ? {tools: m.tools.map((t) => ({label: t.label, summary: t.summary, ok: t.ok, result: clip(t.result, 2000), brief: toolResultSummary(t.label, t.result), ...(t.diff ? {diff: t.diff.slice(0, 400)} : {})}))} : {}),
  };
}

/** An engine event as the page wants it (no class instances, results clipped). */
export function eventView(ev: EngineEvent, label: (ref: {provider: string; model: string}) => string): Record<string, unknown> | undefined {
  switch (ev.type) {
    case 'text':
      return {type: 'text', delta: ev.delta};
    case 'tool': {
      const a = ev.activity;
      if (a.origin) return undefined; // a subagent's call: its own view
      return a.phase === 'start'
        ? {type: 'tool', phase: 'start', id: a.id, label: a.label, summary: a.summary}
        : {type: 'tool', phase: 'end', id: a.id, label: a.label, summary: a.summary, ok: a.ok, result: clip(a.result, 8000), brief: toolResultSummary(a.label, a.result), note: approvalNote(a.approvedBy, a.judge).replace(/^ · /, ''), ...(a.diff ? {diff: a.diff.slice(0, 400)} : {}), ...(a.warning ? {warning: a.warning} : {})};
    }
    case 'route':
      // The terminal's route line: `Opus · effort high · Claude Account 1 (auto · 0.91)`.
      return {type: 'route', model: label(ev.route.ref), line: safeRoute(ev), ...(ev.effort ? {effort: ev.effort} : {})};
    case 'tokens':
      return {type: 'tokens', ...ev.call};
    case 'compact':
      return ev.phase === 'start' ? {type: 'compact', phase: 'start', messages: ev.messages} : {type: 'compact', phase: 'end', result: 'skipped' in ev.result ? {skipped: ev.result.skipped} : {summarized: ev.result.summarized}};
    case 'waiting':
      return {type: 'waiting', until: ev.until};
    case 'notice':
      return {type: 'notice', text: ev.text};
    case 'done':
      return {type: 'done', interrupted: ev.interrupted};
    case 'error':
      return {type: 'error', message: ev.message};
  }
}

/** A command's window, as the page draws it: lists and text as data, /settings and /model as forms. */
async function windowView(o: Overlay): Promise<Record<string, unknown> | undefined> {
  const {runtime} = await import('../runtime.js');
  const panels = await import('./panels.js');
  switch (o.name) {
    case 'text':
      return {name: 'text', title: o.title, lines: o.lines};
    case 'settings':
      return {name: 'settings', ...panels.settingsView(o.tab)};
    case 'model':
      return {name: 'model', ...(await panels.modelView())};
    case 'plans':
      return {name: 'plans', plans: o.plans.map((p) => ({file: p.file, title: p.title, done: p.milestones.filter((m) => m.done).length, total: p.milestones.length}))};
    case 'mcp':
      return {name: 'mcp', servers: runtime.mcp.list().map((x) => ({name: x.name, status: x.status, tools: x.tools, transport: x.transport, source: x.source, ...(x.error ? {error: x.error.slice(0, 200)} : {})}))};
    case 'marketplace':
      return marketView(false);
    case 'marketplace-updates':
      return {name: 'marketplace-updates', updates: o.updates.map((u) => ({...u, name: o.items.find((i) => i.id === u.id)?.name ?? u.id}))};
    case 'goal': {
      const g = runtime.goals.goal;
      const {goalSummary} = await import('../commands/run.js');
      const p = g?.plan ? runtime.goals.plan() : undefined;
      return g ? {name: 'goal', text: g.text, status: g.status, rounds: g.rounds, escalations: g.escalations, checks: g.checks.slice(-12).map((c) => ({at: c.at, kind: c.kind, verdict: c.verdict})), ...(p ? {plan: {title: p.title, milestones: p.milestones.map((m) => ({text: m.text, done: m.done}))}} : {}), summary: goalSummary(g)} : {name: 'text', title: 'Goal', lines: ['No goal set. /goal <text> sets one.']};
    }
    case 'help': {
      const {COMMANDS} = await import('../commands/index.js');
      const {extensions} = await import('../extensions/index.js');
      const {loadSkills} = await import('../skills/index.js');
      return {
        name: 'help',
        commands: COMMANDS.map((c) => ({name: c.name, usage: c.usage, listed: c.listed !== false})),
        extensions: extensions.commands.map((c) => ({name: c.value.name, usage: c.value.usage ?? c.value.description, item: c.item})),
        skills: loadSkills().map((k) => ({name: k.name, description: k.description, source: k.source})),
      };
    }
    case 'btw':
      return {name: 'btw', question: o.question, answer: o.answer ?? '', model: o.model, mode: o.mode, done: !!o.done, error: o.error};
    case 'update':
      return {name: 'update', lines: updateLog.map((l) => (typeof l === 'string' ? l : (l as {text?: string}).text ?? JSON.stringify(l)))};
    case 'agents':
      return {name: 'agents', agents: runtime.agents.list().map((a) => agentView(a))};
    case 'shells':
      return {name: 'shells', shells: runtime.tools.shells.list().map((sh) => shellView(runtime, sh))};
    case 'shell': {
      const sh = runtime.tools.shells.get(o.id);
      return sh ? {name: 'shells', open: sh.id, shells: runtime.tools.shells.list().map((x) => shellView(runtime, x, x.id === sh.id))} : {name: 'text', title: 'Shell', lines: [`No shell #${o.id}.`]};
    }
    case 'rewind': {
      const {REWIND_MODES} = await import('../session/rewind.js');
      return {name: 'rewind', points: o.points, modes: REWIND_MODES.map(([mode, label, hint]) => ({mode, label, hint}))};
    }
    default:
      return undefined;
  }
}

function agentView(a: import('../agents/manager.js').Subagent, withEvents = false) {
  return {
    id: a.id,
    name: a.name,
    task: a.task,
    mode: a.mode,
    model: a.modelLabel ?? a.requested,
    status: a.status,
    background: a.background,
    startedAt: a.startedAt,
    ...(a.endedAt ? {endedAt: a.endedAt} : {}),
    ...(a.error ? {error: a.error} : {}),
    ...(withEvents ? {events: a.events.slice(-300).map((e) => (e.kind === 'tool' ? {kind: 'tool', label: e.label, summary: e.summary, ok: e.ok, result: clip(e.result ?? '', 4000)} : e)), output: a.output} : {}),
  };
}

function shellView(runtime: typeof import('../runtime.js').runtime, sh: import('../tools/shells.js').Shell, withOutput = false) {
  return {
    id: sh.id,
    command: sh.command,
    status: sh.status,
    background: sh.background,
    startedAt: sh.startedAt,
    ...(sh.endedAt ? {endedAt: sh.endedAt} : {}),
    ...(sh.exitCode !== undefined ? {exitCode: sh.exitCode} : {}),
    origin: sh.origin ? 'agent' : 'you',
    ...(withOutput ? {output: runtime.tools.shells.tail(sh, 400)} : {}),
  };
}

function skillTag(s: import('../skills/index.js').Skill): string {
  if (s.marketplace) return 'marketplace';
  return s.source === 'builtin' ? 'skill' : s.source === 'plugin' ? `plugin${s.plugin ? ` ${s.plugin}` : ''}` : s.source.replace('-', ' ');
}

let updateLog: unknown[] = [];

/** The marketplace store: every marketplace's items, what's installed, and updates. */
async function marketView(refresh: boolean) {
  const m = await import('../marketplace/index.js');
  const {describe} = await import('../marketplace/actions.js');
  const markets = await m.loadMarketplaces({refresh});
  const installed = m.installedItems();
  return {
    name: 'marketplace',
    categories: m.CATEGORIES,
    markets: markets.map((x) => ({url: x.url, name: x.name, official: x.official, ...(x.error ? {error: x.error} : {}), updatedAt: x.updatedAt})),
    items: markets.flatMap((x) =>
      x.items.map((it) => ({
        id: it.id,
        name: it.name,
        version: it.version,
        description: it.description,
        author: it.author,
        category: it.category,
        tags: it.tags,
        icon: it.icon,
        homepage: it.homepage,
        requires: it.requires,
        adds: it.adds,
        what: describe(it).replace(/^ · /, ''),
        readme: it.readme?.slice(0, 20_000),
        marketplace: x.name,
        installed: installed.find((i) => i.id === it.id)?.version,
      })),
    ),
    updates: m.updatesFor(markets),
  };
}

function mcpLines(runtime: typeof import('../runtime.js').runtime): string[] {
  const list = runtime.mcp.list();
  if (!list.length) return ['No MCP servers. Add them in ~/.rein/mcp.json or the project’s .mcp.json (see the MCP docs).'];
  return list.map((s: any) => `${String(s.state ?? s.status ?? '').padEnd(10)} ${s.name}${s.tools !== undefined ? ` · ${Array.isArray(s.tools) ? s.tools.length : s.tools} tools` : ''}${s.error ? ` · ${s.error}` : ''}`);
}

export async function runWorker(): Promise<number> {
  // stdout is the protocol: anything printed goes to stderr.
  console.log = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`);
  const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');
  const {runtime} = await import('../runtime.js');
  const {catalog} = await import('../router/catalog.js');
  const {loadTranscript} = await import('../session/transcript.js');
  const {runCommand, goalSummary} = await import('../commands/run.js');
  const {loadSkills} = await import('../skills/index.js');
  const {Attachments} = await import('../ui/attachments.js');
  const {extensions} = await import('../extensions/index.js');
  const panels = await import('./panels.js');
  const nodePath = await import('node:path');
  const {rewindPoints, rewindTo} = await import('../session/rewind.js');
  const {previewTool} = await import('../preview/tool.js');
  const {BrowserView} = await import('../preview/cdp.js');
  const {VncView, NeedsPassword} = await import('../preview/vnc.js');
  const label = (ref: {provider: string; model: string}) => catalog.get(ref as Parameters<typeof catalog.get>[0])?.label ?? ref.model;

  const waiting = new Map<number, (v: any) => void>();
  let asks = 0;
  const ask = <T>(kind: string, payload: unknown): Promise<T> =>
    new Promise((resolve) => {
      const id = ++asks;
      waiting.set(id, resolve);
      send({t: 'ask', id, kind, payload});
    });
  runtime.approver = async (req) => {
    const v = await ask<string>('approval', {tool: req.tool.label ?? req.tool.name, summary: req.summary, preview: clip(req.preview ?? '', 20_000), sensitive: !!req.sensitive, outside: req.outside ?? [], ...(req.suggestion ? {suggestion: req.suggestion} : {})});
    return v === 'once' || v === 'session' || v === 'always' ? v : 'deny';
  };
  runtime.askPresenter = (questions) => ask('question', {questions});
  runtime.planPresenter = (plan) => ask('plan', plan);

  let busy = false;
  let queue: string[] = [];
  let skills = loadSkills();
  let overlay: Overlay = {name: 'none'};
  const mode = () => (runtime.planMode ? 'plan' : runtime.config.toolApproval);
  const snapshot = (): Snapshot => {
    const t = runtime.engine.transcript;
    const first = t.messages.find((m) => m.role === 'user' && !m.synthetic);
    return {
      session: t.id,
      cwd: process.cwd(),
      title: first ? first.text.split('\n')[0]!.slice(0, 80) : 'New chat',
      messages: t.messages.filter((m) => !m.synthetic).map(messageView),
      models: catalog.all().map((m) => ({ref: `${m.provider}:${m.id}`, label: m.label, provider: m.provider})),
      chatModel: runtime.config.chatModel ?? 'auto',
      mode: mode(),
      busy,
      status: panels.statusView(),
      sidebar: panels.sidebarView(),
      queued: queue,
      accent: accentNow(),
      previews: previewList(),
    };
  };
  // The status line and sidebar follow the conversation: sent after each event burst, at most every 250ms.
  let chromeTimer: NodeJS.Timeout | undefined;
  const chrome = () => {
    if (chromeTimer) return;
    chromeTimer = setTimeout(() => {
      chromeTimer = undefined;
      try {
        send({t: 'event', ev: {type: 'chrome', status: panels.statusView(), sidebar: panels.sidebarView(), queued: queue, mode: mode(), chatModel: runtime.config.chatModel ?? 'auto', accent: accentNow(), previews: previewList()}});
      } catch {}
    }, 250);
  };
  extensions.on('change', chrome);
  // A theme from a marketplace item, else your theme setting: the page takes its accent, as the terminal does.
  const accentNow = () => extensions.theme?.accent || runtime.config.theme?.accent || undefined;
  // An open shells or subagents window follows them live (at most every 300ms).
  let liveTimer: NodeJS.Timeout | undefined;
  const live = () => {
    if (liveTimer || !['shells', 'shell', 'agents'].includes(overlay.name)) return;
    liveTimer = setTimeout(() => {
      liveTimer = undefined;
      if (['shells', 'shell', 'agents'].includes(overlay.name)) void showWindow(overlay, true);
    }, 300);
  };
  runtime.tools.shells.on('change', live);
  runtime.tools.shells.on('data', live);
  runtime.agents.on('change', () => (live(), chrome()));
  runtime.mcp.on('change', () => overlay.name === 'mcp' && void showWindow(overlay, true));

  // A command's echo ('user' through logMain) shows as "> /cost" with its output, not as a message;
  // a message you sent comes through add() and is a 'user' event.
  const log = (kind: 'info' | 'error' | 'user', text: string) => {
    send({t: 'event', ev: kind === 'user' ? {type: 'cmd', text} : {type: 'log', kind, text}});
  };

  const turn = async (text: string, images: import('../providers/types.js').ImageInput[] = []) => {
    busy = true;
    send({t: 'busy', busy, phrase: pickPhrase()});
    let error: string | undefined;
    const one = async (message: string, attached: typeof images = []) => {
      for await (const ev of runtime.engine.send(message, attached)) {
        const v = eventView(ev, label);
        if (v) send({t: 'event', ev: v});
        if (ev.type === 'error') error = ev.message;
        if (ev.type === 'tool' || ev.type === 'route' || ev.type === 'tokens' || ev.type === 'done') chrome();
      }
    };
    try {
      await one(text, images);
      // Stop hooks and the end-of-turn code check may send the agent back to work, as in the terminal.
      for (let depth = 0; !error && depth < 10; depth++) {
        const stop = await runtime.stopHook(depth > 0).catch(() => undefined);
        if (!stop) break;
        send({t: 'event', ev: {type: 'notice', text: stop.kind === 'hook' ? `Stop hook: ${stop.reason}` : `Code check: ${stop.reason.split('\n')[0]}`}});
        await one(stop.kind === 'hook' ? `<stop_hook>\n${stop.reason}\n</stop_hook>\nContinue working.` : `<code_check>\n${stop.reason}\n</code_check>`);
      }
    } catch (err) {
      send({t: 'event', ev: {type: 'error', message: (err as Error).message}});
    }
    busy = false;
    send({t: 'busy', busy});
    send({t: 'snapshot', snapshot: snapshot()});
    extensions.emit('turnEnd');
    // What was typed during the turn, in order.
    const next = queue.shift();
    if (next !== undefined) {
      chrome();
      command(next);
    }
  };

  /** `again`: a live refresh of the open window, which keeps what the page has open in it. */
  const showWindow = async (o: Overlay, again = false) => {
    overlay = o;
    if (o.name === 'none') return send({t: 'event', ev: {type: 'window', close: true}});
    if (o.name === 'vault') {
      const value = await ask<string | undefined>('vault', {secret: o.secret});
      if (typeof value !== 'string' || !value) return log('info', `Nothing saved for ${o.secret}.`);
      return runtime.vault.set(o.secret, value).then(
        (where) => log('info', `Saved ${o.secret} in the vault (${where === 'keychain' ? (process.platform === 'darwin' ? 'macOS Keychain' : 'encrypted with DPAPI') : 'secrets/vault.json, 0600'}). The agent's shell commands get it as $${o.secret}.`),
        (err) => log('error', `Couldn't save ${o.secret}: ${(err as Error).message}`),
      );
    }
    if (o.name === 'login') {
      const w = await loginView().catch((err) => ({name: 'text', title: 'Accounts', lines: [(err as Error).message]}));
      return send({t: 'event', ev: {type: 'window', window: w, ...(again ? {refresh: true} : {})}});
    }
    const w = await windowView(o).catch((err) => ({name: 'text', title: 'Error', lines: [(err as Error).message]}));
    if (w) send({t: 'event', ev: {type: 'window', window: w, ...(again ? {refresh: true} : {})}});
    else log('info', `/${o.name} doesn't have a window in the web UI yet.`);
  };

  // /login in the browser: the same account flows as the terminal's, through the official CLIs. A
  // Claude login prints a URL and takes the code shown after signing in; Codex uses a device code,
  // entered on OpenAI's page from any device (no callback to this machine needed).
  type LoginRun = {account: import('../providers/types.js').Account; flow: import('../providers/types.js').LoginFlow; isNew: boolean; url?: string; code?: string; needsCode?: boolean; output: string; error?: string};
  let login: LoginRun | undefined;
  const {listAccounts, startAdd, finishAdd, abandonAdd, reauth, saveIdentity} = await import('../accounts/service.js');
  const {getJevKey, setJevKey, deleteJevKey} = await import('../store/secrets.js');
  const {accountName} = await import('../ui/privacy.js');
  const {PROVIDERS} = await import('../providers/types.js');
  const loginView = async () => {
    const rows = await listAccounts();
    return {
      name: 'login',
      accounts: rows.map(({account, status}) => ({
        id: account.id,
        provider: PROVIDERS[account.provider].name,
        name: accountName(account),
        ...((status.loggedIn ? status.plan : undefined) ?? account.plan ? {plan: (status.loggedIn ? status.plan : undefined) ?? account.plan} : {}),
        ...(account.api ? {api: account.api} : {}),
        imported: !!account.imported,
        signedIn: !!status.loggedIn,
        ...(!status.loggedIn && status.error ? {error: status.error.slice(0, 120)} : {}),
      })),
      jev: !!(await getJevKey().catch(() => undefined)),
      ...(login ? {flow: {provider: PROVIDERS[login.account.provider].name, name: accountName(login.account), url: login.url, code: login.code, needsCode: !!login.needsCode, output: login.output.slice(-1500), error: login.error}} : {}),
    };
  };
  const runLogin = async (l: LoginRun) => {
    login?.flow.cancel();
    login = l;
    const redraw = () => overlay.name === 'login' && void showWindow({name: 'login'}, true);
    let finished = false;
    for await (const ev of l.flow.events) {
      if (login !== l) break;
      if (ev.type === 'url') l.url = ev.url;
      else if (ev.type === 'deviceCode') Object.assign(l, {url: ev.url, code: ev.code});
      else if (ev.type === 'needsCode') l.needsCode = true;
      else if (ev.type === 'output') l.output += ev.text;
      else if (ev.type === 'error') Object.assign(l, {error: ev.message, needsCode: false});
      else if (ev.type === 'done') {
        finished = true;
        try {
          if (l.isNew) {
            const saved = await finishAdd(l.account, ev.status);
            log('info', `Added ${PROVIDERS[saved.provider].name} account ${accountName(saved)} (${saved.plan ?? 'unknown plan'})`);
          } else {
            await saveIdentity(l.account, ev.status);
            log('info', `Re-authenticated ${accountName(l.account)}`);
          }
        } catch (err) {
          log('error', (err as Error).message);
        }
      }
      redraw();
    }
    if (!finished && l.isNew) await abandonAdd(l.account).catch(() => {});
    if (!finished && l.error) log('error', `Login failed: ${l.error}`);
    if (login === l) login = undefined;
    await runtime.refreshCatalog().catch(() => {});
    chrome();
    redraw();
  };

  // Previews (preview/): a streamed browser or display per open preview, while the page looks at it.
  const views = new Map<number, InstanceType<typeof BrowserView> | InstanceType<typeof VncView>>();
  let watching = true;
  const previewList = () =>
    runtime.previews.list().map((p) => {
      const v = views.get(p.id);
      return {id: p.id, kind: p.kind, target: p.target, title: p.title, source: p.source, open: !!v, ...(v instanceof BrowserView && v.url ? {url: v.url} : {}), ...(p.remote ? {remote: true} : {})};
    });
  const openView = async (id: number, size: {width: number; height: number}, password?: string) => {
    const p = runtime.previews.get(id);
    if (!p) throw new Error('that preview is gone');
    const had = views.get(id);
    if (had) {
      if (had instanceof BrowserView) await had.resize(size);
      else had.full();
      await had.stream(true);
      return {id, url: had instanceof BrowserView ? had.url : undefined};
    }
    const frame = (ev: Record<string, unknown>) => send({t: 'event', ev: {type: 'pframe', id, ...ev}});
    if (p.kind === 'url') {
      const v = new BrowserView();
      views.set(id, v);
      v.on('frame', (f) => frame({format: 'jpeg', data: f.data, width: f.width, height: f.height}));
      v.on('navigated', (url) => send({t: 'event', ev: {type: 'preview-url', id, url}}));
      v.on('notice', (text) => log('info', text));
      v.on('closed', () => (views.delete(id), chrome()));
      try {
        await v.start(p.target, size);
      } catch (err) {
        v.close();
        throw err;
      }
      if (!watching) await v.stream(false);
    } else {
      const v = new VncView();
      views.set(id, v);
      v.on('patch', (pt) => frame({format: 'png', ...pt}));
      v.on('notice', (text) => log('info', text));
      v.on('closed', () => views.get(id) === v && (views.delete(id), chrome()));
      try {
        await v.start(p.target, password ?? p.password);
        if (password) p.password = password; // it worked: kept for reconnecting (never sent to the page)
      } catch (err) {
        views.delete(id);
        v.close();
        // The page asks for the password, then opens it again with it.
        if (err instanceof NeedsPassword) return {id, needsPassword: true, error: err.message};
        throw err;
      }
      v.full();
    }
    chrome();
    return {id};
  };
  runtime.previews.on('change', () => {
    // A preview that went (its server stopped) closes its view.
    for (const id of [...views.keys()]) if (!runtime.previews.get(id)) views.get(id)?.close();
    chrome();
  });

  const ui: import('../commands/run.js').CommandUi = {
    surface: 'web',
    windowed: false,
    viewing: undefined,
    logMain: log,
    add: (e) => {
      if (e.kind === 'user') return send({t: 'event', ev: {type: 'user', text: e.text}});
      if (e.kind === 'info' || e.kind === 'error') return log(e.kind, e.text);
      if (e.kind === 'usage') return send({t: 'event', ev: {type: 'usage', rows: panels.usageRows(e.rows), jev: e.jev}});
      if (e.kind === 'context') return send({t: 'event', ev: {type: 'context', report: e.report}});
      if (e.kind === 'update') return log('info', String((e.line as any).text ?? e.line));
      if (e.kind === 'compact') return send({t: 'event', ev: {type: 'notice', text: 'skipped' in e.result ? `Nothing to compact: ${e.result.skipped}` : `Compacted ${e.result.summarized} messages.`}});
    },
    // /clear: the engine is reset by the command; the page gets the empty conversation.
    setEntries: () => {
      queue = [];
      send({t: 'event', ev: {type: 'clear'}});
      send({t: 'snapshot', snapshot: snapshot()});
    },
    banner: () => ({id: 0, kind: 'banner', text: ''}),
    bump: chrome,
    chat: {
      get busy() {
        return busy;
      },
      send: (text, images) => turn(text, images ?? []),
    },
    setOverlay: (o) => void showWindow(typeof o === 'function' ? o(overlay) : o),
    setQueued: (f) => {
      queue = typeof f === 'function' ? f(queue) : f;
      chrome();
    },
    setView: () => {},
    attachments: {current: new Attachments(() => nodePath.join(runtime.engine.scratch, 'images'), () => runtime.config.collapsePastes !== false)},
    get skills() {
      return skills;
    },
    setSkills: (s) => (skills = s),
    opts: {renderer: 'classic', onClear: () => {}},
    updating: false,
    setUpdating: () => {},
    setUpdateLog: (f) => {
      updateLog = typeof f === 'function' ? f(updateLog as never) : f;
      if (overlay.name === 'update') void showWindow(overlay, true);
    },
    compacting: undefined,
    setCompacting: (v) => send({t: 'event', ev: v ? {type: 'compact', phase: 'start', label: v.label} : {type: 'compact', phase: 'end'}}),
    openRewind: () => void showWindow({name: 'rewind', points: rewindPoints()}),
    openPreview: (id) => send({t: 'event', ev: {type: 'preview-show', id}}),
    openShells: () => void showWindow({name: 'shells'}),
    exit: () => {},
    refresh: async () => {
      skills = loadSkills();
      await runtime.refreshCatalog().catch(() => {});
      chrome();
    },
  };
  const command = (text: string) => {
    try {
      runCommand(text, ui);
    } catch (err) {
      log('error', (err as Error).message);
    }
    chrome();
  };
  void goalSummary;

  const handle = async (m: any) => {
    switch (m.t) {
      case 'init': {
        await runtime.init({resume: false});
        if (typeof m.resume === 'string') {
          const t = await loadTranscript(m.resume);
          if (t) runtime.engine.load(t);
        }
        await runtime.refreshCatalog();
        // Claude models' real context windows, for those never used yet (as the terminal does).
        void catalog.probeWindows().catch(() => {});
        await runtime.loadExtensions().catch(() => {});
        // The agent can show the user what it made, live, wherever they are (web UI chats only).
        runtime.tools.register(previewTool(runtime.previews, (id) => send({t: 'event', ev: {type: 'preview-show', id}}), () => runtime.config.reinRemote));
        runtime.engine.refreshTools();
        skills = loadSkills();
        return send({t: 'ready', snapshot: snapshot()});
      }
      case 'send':
        // Everything typed goes through the same commands as the terminal: messages, /commands, skills, !shell.
        if (typeof m.text === 'string' && m.text.trim()) command(m.text);
        return;
      case 'interrupt':
        runtime.tools.shells.killForeground();
        runtime.agents.cancelAll({foregroundOnly: true});
        return runtime.engine.interrupt();
      case 'answer': {
        const r = waiting.get(m.id);
        waiting.delete(m.id);
        return r?.(m.value);
      }
      case 'request': {
        // The page asks the worker something and waits for the reply (the / list, a setting's change…).
        const reply = (value: unknown) => send({t: 'reply', id: m.id, value});
        try {
          return reply(await request(m.op, m.args ?? {}));
        } catch (err) {
          return send({t: 'reply', id: m.id, error: (err as Error).message});
        }
      }
      case 'model':
        await runtime.setConfig({chatModel: String(m.model)});
        return send({t: 'snapshot', snapshot: snapshot()});
      case 'mode':
        runtime.planMode = m.mode === 'plan';
        if (m.mode !== 'plan' && ['ask', 'auto', 'bypass'].includes(m.mode)) await runtime.setConfig({toolApproval: m.mode});
        return send({t: 'snapshot', snapshot: snapshot()});
      case 'compact':
        return command('/compact');
      case 'watching':
        // Frames only while a page is looking (the server says when the last one goes).
        watching = !!m.on;
        for (const v of views.values()) void v.stream(watching);
        return;
    }
  };

  const request = async (op: string, args: Record<string, any>): Promise<unknown> => {
    const {suggestCommands} = await import('../commands/index.js');
    switch (op) {
      case 'suggest':
        // The same list, ranking and descriptions as the terminal's; `tag` says where a skill comes from.
        return suggestCommands(String(args.text ?? ''), skills).map((c) => ({name: c.name, description: c.description, ...(c.skill ? {tag: skillTag(c.skill)} : c.extension ? {tag: 'marketplace'} : {})}));
      case 'setting': {
        await panels.applySetting(String(args.key), args.value, !!args.typed);
        chrome();
        return panels.settingsView(args.tab);
      }
      case 'layout': {
        const key = args.key === 'statusLine' ? 'statusLine' : 'sidebarSections';
        await runtime.setConfig({[key]: (args.ids as unknown[]).map(String)});
        chrome();
        return panels.settingsView(args.tab);
      }
      case 'model': {
        const said = await panels.applyModel(String(args.section), String(args.value));
        chrome();
        return {said, view: await panels.modelView()};
      }
      case 'plan-goal': {
        const {listPlans} = await import('../plans/store.js');
        const p = listPlans(process.cwd()).find((x) => x.file === args.file);
        if (!p) throw new Error('that plan is gone');
        const goal = runtime.goals.set(`Carry out the plan "${p.title}"`, p.file);
        log('info', `◎ Goal: carry out the plan "${p.title}" — ${p.milestones.filter((x) => x.done).length}/${p.milestones.length} milestones done. Progress shows in the sidebar; /goal pause · resume · clear`);
        const kick = runtime.goals.kickoff(goal);
        if (busy) queue.push(kick);
        else void turn(kick);
        return {ok: true};
      }
      case 'rewind': {
        const index = Number(args.index);
        const mode = (['both', 'conversation', 'code'] as const).find((m) => m === args.mode);
        if (!mode || !rewindPoints().some((p) => p.index === index)) throw new Error('pick one of your messages, and what to restore');
        if (busy) {
          runtime.tools.shells.killForeground();
          runtime.engine.interrupt();
        }
        const text = await rewindTo(index, mode, log);
        if (text !== undefined) {
          send({t: 'event', ev: {type: 'clear'}});
          log('info', 'Conversation rewound — your message is back in the box.');
        }
        send({t: 'snapshot', snapshot: snapshot()});
        await showWindow({name: 'none'});
        return {draft: text};
      }
      case 'shell': {
        const sh = runtime.tools.shells.get(Number(args.id));
        if (!sh) throw new Error('that shell is gone');
        overlay = {name: 'shell', id: sh.id};
        return shellView(runtime, sh, true);
      }
      case 'shell-kill':
        if (!runtime.tools.shells.kill(Number(args.id))) throw new Error('that shell already ended');
        return {ok: true};
      case 'agent': {
        const a = runtime.agents.get(Number(args.id));
        if (!a) throw new Error('that subagent is gone');
        return agentView(a, true);
      }
      case 'agent-message': {
        const a = runtime.agents.get(Number(args.id));
        if (!a) throw new Error('that subagent is gone');
        if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('nothing to send');
        await runtime.agents.message(a.id, args.text.trim());
        return agentView(a, true);
      }
      case 'agent-stop':
        if (!runtime.agents.cancel(Number(args.id))) throw new Error("that subagent isn't running");
        return {ok: true};
      case 'login-start': {
        const provider = args.provider === 'codex' ? 'codex' : args.provider === 'claude' ? 'claude' : undefined;
        const api = (['console', 'openai', 'bedrock', 'vertex'] as const).find((a) => a === args.api);
        if (!provider) throw new Error('which provider?');
        const apiConfig = api === 'bedrock' || api === 'vertex' ? Object.fromEntries(Object.entries((args.apiConfig ?? {}) as Record<string, unknown>).filter(([k, v]) => ['region', 'profile', 'projectId'].includes(k) && typeof v === 'string' && v.trim()).map(([k, v]) => [k, String(v).trim()])) : undefined;
        const {account, flow} = await startAdd(provider, api ? {api, ...(apiConfig ? {apiConfig} : {})} : undefined, {remote: true});
        void runLogin({account, flow, isNew: true, output: ''});
        return {ok: true};
      }
      case 'login-reauth': {
        const row = (await listAccounts()).find((r) => r.account.id === args.id);
        if (!row) throw new Error('that account is gone');
        void runLogin({account: row.account, flow: reauth(row.account, {remote: true}), isNew: false, output: ''});
        return {ok: true};
      }
      case 'login-code':
        if (!login) throw new Error('no login in progress');
        if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('paste the code first');
        login.flow.submitCode(args.code.trim());
        login.needsCode = false;
        return {ok: true};
      case 'login-cancel':
        login?.flow.cancel();
        return {ok: true};
      case 'account-remove': {
        const row = (await listAccounts()).find((r) => r.account.id === args.id);
        if (!row) throw new Error('that account is gone');
        await runtime.removeAccount(row.account);
        log('info', `Removed ${accountName(row.account)}${row.account.imported ? ' (unregistered; your CLI login is untouched)' : ''}`);
        chrome();
        return loginView();
      }
      case 'jev-set': {
        const {checkJevKey} = await import('../decider/jev.js');
        const key = String(args.key ?? '').trim();
        if (!key) throw new Error('paste the key first');
        const models = await checkJevKey(key);
        const where = await setJevKey(key);
        log('info', `Jev key saved (${where === 'keychain' ? 'macOS Keychain' : '~/.rein/secrets, 0600'})${models.length ? ` · models: ${models.join(', ')}` : ''}. Pick Jev as the decision model in /model.`);
        return loginView();
      }
      case 'jev-remove':
        await deleteJevKey();
        log('info', 'Jev key removed. Decisions fall back to the cheapest model.');
        return loginView();
      case 'market': {
        overlay = {name: 'marketplace'};
        return marketView(!!args.refresh);
      }
      case 'market-install':
      case 'market-uninstall': {
        const {installItem, uninstallItem} = await import('../marketplace/actions.js');
        const {loadMarketplaces} = await import('../marketplace/index.js');
        const id = String(args.id ?? '');
        let said: string;
        if (op === 'market-install') {
          const all = (await loadMarketplaces()).flatMap((x) => x.items);
          const r = await installItem(runtime, all, id);
          said = r.lines.join('\n') + (r.restart ? '\nRestart Rein to start its MCP servers and hooks.' : '');
        } else said = await uninstallItem(runtime, id);
        log('info', said);
        skills = loadSkills();
        chrome();
        return {said, view: await marketView(false)};
      }
      case 'market-update': {
        const {installItem} = await import('../marketplace/actions.js');
        const {loadMarketplaces} = await import('../marketplace/index.js');
        const all = (await loadMarketplaces()).flatMap((x) => x.items);
        const lines: string[] = [];
        let restart = false;
        for (const id of (Array.isArray(args.ids) ? args.ids : []).map(String)) {
          try {
            const r = await installItem(runtime, all, id);
            lines.push(...r.lines);
            restart ||= r.restart;
          } catch (err) {
            lines.push(`${id}: ${(err as Error).message}`);
          }
        }
        const said = lines.join('\n') + (restart ? '\nRestart Rein to start the updated MCP servers and hooks.' : '');
        log('info', said || 'Nothing to update.');
        skills = loadSkills();
        chrome();
        await showWindow({name: 'none'});
        return {said};
      }
      case 'market-add':
      case 'market-remove': {
        const m = await import('../marketplace/index.js');
        const url = String(args.url ?? '').trim();
        if (!url) throw new Error('which repo?');
        if (op === 'market-add') {
          const added = await m.addMarketplace(url);
          log('info', `Added ${added.name} (${added.items.length} item${added.items.length === 1 ? '' : 's'}).`);
        } else log('info', `Removed ${m.removeMarketplace(url)}. Items you installed from it stay installed.`);
        return marketView(false);
      }
      case 'mcp': {
        const name = String(args.name ?? '');
        const s = runtime.mcp.list().find((x) => x.name === name);
        if (!s) throw new Error(`no MCP server ${name}`);
        if (s.status === 'changed') runtime.mcp.acceptChange(s.name);
        else if (s.status === 'needs-approval') {
          const {approveProjectServer} = await import('../mcp/config.js');
          approveProjectServer(process.cwd(), s.name);
          await runtime.mcp.start();
        } else if (s.status === 'needs-auth') {
          // The server's OAuth page; its redirect comes back to this machine.
          let url: string | undefined;
          const done = runtime.mcp.signIn(s.name, (u) => {
            url = u;
            send({t: 'event', ev: {type: 'window', window: {name: 'mcp-signin', server: s.name, url: u}, refresh: true}});
          });
          void done.then(
            () => (log('info', `Signed in to ${s.name}.`), void showWindow({name: 'mcp'})),
            (err) => log('error', `Sign-in to ${s.name} failed: ${(err as Error).message}`),
          );
          await new Promise((r) => setTimeout(r, 1500));
          return {url};
        } else await runtime.mcp.reconnect(s.name);
        await showWindow({name: 'mcp'}, true);
        return {ok: true};
      }
      case 'remote-port': {
        // For the web UI server only (it refuses this op from the page): where Rein Remote listens.
        const p = runtime.previews.get(Number(args.id));
        if (!p?.remote) throw new Error('that preview has no Rein Remote stream');
        return p.remote;
      }
      case 'preview-open':
        return openView(Number(args.id), {width: Number(args.width) || 1280, height: Number(args.height) || 800}, typeof args.password === 'string' && args.password ? args.password : undefined);
      case 'preview-input': {
        const v = views.get(Number(args.id));
        const ev = args.ev as {type?: string};
        if (!v || !ev || !['mouse', 'wheel', 'key', 'text'].includes(String(ev.type))) return {ok: false};
        await v.input(ev as never);
        return {ok: true};
      }
      case 'preview-nav': {
        const v = views.get(Number(args.id));
        if (!(v instanceof BrowserView)) throw new Error('only a web preview navigates');
        if (args.dir === 'back' || args.dir === 'forward' || args.dir === 'reload') await v.history(args.dir);
        else await v.navigate(String(args.url ?? ''));
        return {ok: true};
      }
      case 'preview-full': {
        // A page dropped frames (a slow link): the whole screen again, so nothing stale stays.
        const v = views.get(Number(args.id));
        if (v instanceof VncView) v.full();
        return {ok: true};
      }
      case 'preview-resize': {
        const v = views.get(Number(args.id));
        if (v instanceof BrowserView) await v.resize({width: Number(args.width), height: Number(args.height)});
        return {ok: true};
      }
      case 'preview-close':
        views.get(Number(args.id))?.close();
        if (args.remove) runtime.previews.remove(Number(args.id));
        chrome();
        return {ok: true};
      case 'preview-add': {
        // The user opens one themselves: a URL, or a VNC display, typed into the page.
        const {vncTarget} = await import('../preview/registry.js');
        const t = String(args.target ?? '').trim();
        const vnc = /^(vnc:\/\/)?[\w.[\]-]*:\d+$/i.test(t) && !/^https?:/i.test(t) ? vncTarget(t) : undefined;
        if (vnc) return runtime.previews.add({kind: 'vnc', target: vnc, title: vnc, source: 'agent'});
        let u: URL;
        try {
          u = new URL(/^https?:\/\//i.test(t) ? t : `http://${t}`);
        } catch {
          throw new Error('give a URL (localhost:3000) or a VNC display (:1, host:5901)');
        }
        return runtime.previews.add({kind: 'url', target: u.toString(), title: u.host, source: 'agent'});
      }
      case 'unqueue':
        queue = queue.filter((_, i) => i !== Number(args.index));
        chrome();
        return {queued: queue};
    }
    throw new Error(`unknown request ${op}`);
  };

  readline.createInterface({input: process.stdin}).on('line', (line) => {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    // A turn runs while answers and interrupts keep coming in.
    void handle(m).catch((err) => send({t: 'event', ev: {type: 'error', message: (err as Error).message}}));
  });
  await new Promise<void>((resolve) => process.stdin.on('end', resolve));
  for (const v of views.values()) v.close(); // no headless browser outlives its chat
  runtime.previews.stopAll(); // nor a virtual display
  runtime.shutdown();
  return 0;
}
