import readline from 'node:readline';
import type {EngineEvent} from '../session/engine.js';
import type {Message} from '../session/transcript.js';
import {pickPhrase} from '../ui/phrases.js';
import type {Overlay} from '../ui/useRein.js';

/**
 * One web UI chat (`rein --ui-worker`, started by the server in the project's folder): Rein's
 * runtime and engine, as in the terminal, talking newline JSON over stdin/stdout. The server sends
 * init / send / interrupt / answer / model / mode / compact; this sends ready, events, asks
 * (approvals, questions, plans) and a fresh snapshot after each turn.
 */
export type ToolView = {label: string; summary: string; ok?: boolean; result?: string; diff?: {kind: string; n?: number; text: string}[]};
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
  /** The status line and sidebar, as /settings lays them out (panels.ts). */
  status: StatusSegment[];
  sidebar: SidebarSection[];
  /** Messages typed while the agent was working, run after it finishes. */
  queued: string[];
};
type StatusSegment = ReturnType<typeof import('./panels.js').statusView>[number];
type SidebarSection = import('./panels.js').SidebarSection;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

export function messageView(m: Message): MessageView {
  return {
    role: m.role,
    text: m.text,
    at: m.at,
    ...(m.model ? {model: `${m.model.provider}:${m.model.model}`} : {}),
    ...(m.interrupted ? {interrupted: true} : {}),
    ...(m.tools?.length ? {tools: m.tools.map((t) => ({label: t.label, summary: t.summary, ok: t.ok, result: clip(t.result, 2000), ...(t.diff ? {diff: t.diff.slice(0, 400)} : {})}))} : {}),
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
        : {type: 'tool', phase: 'end', id: a.id, label: a.label, summary: a.summary, ok: a.ok, result: clip(a.result, 8000), ...(a.diff ? {diff: a.diff.slice(0, 400)} : {}), ...(a.warning ? {warning: a.warning} : {})};
    }
    case 'route':
      return {type: 'route', model: label(ev.route.ref), ...(ev.effort ? {effort: ev.effort} : {})};
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
      return {name: 'text', title: 'MCP servers', lines: mcpLines(runtime)};
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
    };
  };
  // The status line and sidebar follow the conversation: sent after each event burst, at most every 250ms.
  let chromeTimer: NodeJS.Timeout | undefined;
  const chrome = () => {
    if (chromeTimer) return;
    chromeTimer = setTimeout(() => {
      chromeTimer = undefined;
      try {
        send({t: 'event', ev: {type: 'chrome', status: panels.statusView(), sidebar: panels.sidebarView(), queued: queue, mode: mode(), chatModel: runtime.config.chatModel ?? 'auto'}});
      } catch {}
    }, 250);
  };
  extensions.on('change', chrome);
  // An open shells or subagents window follows them live (at most every 300ms).
  let liveTimer: NodeJS.Timeout | undefined;
  const live = () => {
    if (liveTimer || !['shells', 'shell', 'agents'].includes(overlay.name) ) return;
    liveTimer = setTimeout(() => {
      liveTimer = undefined;
      if (['shells', 'shell', 'agents'].includes(overlay.name)) void showWindow(overlay, true);
    }, 300);
  };
  runtime.tools.shells.on('change', live);
  runtime.tools.shells.on('data', live);
  runtime.agents.on('change', () => (live(), chrome()));

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
    if (o.name === 'login') return log('info', 'Accounts are signed in from a terminal: run rein there, then /login. Every chat here uses the accounts Rein has.');
    const w = await windowView(o).catch((err) => ({name: 'text', title: 'Error', lines: [(err as Error).message]}));
    if (w) send({t: 'event', ev: {type: 'window', window: w, ...(again ? {refresh: true} : {})}});
    else log('info', `/${o.name} doesn't have a window in the web UI yet.`);
  };

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
    setUpdateLog: () => {},
    compacting: undefined,
    setCompacting: (v) => send({t: 'event', ev: v ? {type: 'compact', phase: 'start', label: v.label} : {type: 'compact', phase: 'end'}}),
    openRewind: () => void showWindow({name: 'rewind', points: rewindPoints()}),
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
  runtime.shutdown();
  return 0;
}
