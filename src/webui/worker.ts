import readline from 'node:readline';
import type {EngineEvent} from '../session/engine.js';
import type {Message} from '../session/transcript.js';
import {pickPhrase} from '../ui/phrases.js';

/**
 * One web UI chat (`rein --ui-worker`, started by the server in the project's folder): Rein's
 * runtime and engine, as in the terminal, talking newline JSON over stdin/stdout. The server sends
 * init / send / interrupt / answer / model / mode / compact; this sends ready, events, asks
 * (approvals, questions, plans) and a fresh snapshot after each turn.
 */
export type ToolView = {label: string; summary: string; ok?: boolean; result?: string; diff?: {kind: string; n?: number; text: string}[]};
export type MessageView = {role: 'user' | 'assistant'; text: string; at: number; model?: string; tools?: ToolView[]; interrupted?: boolean};
export type Snapshot = {session: string; cwd: string; title: string; messages: MessageView[]; models: {ref: string; label: string; provider: string}[]; chatModel: string; mode: 'ask' | 'auto' | 'bypass' | 'plan'; busy: boolean};

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

export async function runWorker(): Promise<number> {
  // stdout is the protocol: anything printed goes to stderr.
  console.log = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`);
  const send = (m: object) => process.stdout.write(JSON.stringify(m) + '\n');
  const {runtime} = await import('../runtime.js');
  const {catalog} = await import('../router/catalog.js');
  const {loadTranscript} = await import('../session/transcript.js');
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
    };
  };

  const turn = async (text: string) => {
    busy = true;
    send({t: 'busy', busy, phrase: pickPhrase()});
    send({t: 'event', ev: {type: 'user', text}}); // a page that connects mid-turn shows what was asked
    let error: string | undefined;
    const one = async (message: string) => {
      for await (const ev of runtime.engine.send(message)) {
        const v = eventView(ev, label);
        if (v) send({t: 'event', ev: v});
        if (ev.type === 'error') error = ev.message;
      }
    };
    try {
      await one(text);
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
  };

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
        return send({t: 'ready', snapshot: snapshot()});
      }
      case 'send':
        if (!busy && typeof m.text === 'string' && m.text.trim()) await turn(m.text);
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
      case 'model':
        await runtime.setConfig({chatModel: String(m.model)});
        return send({t: 'snapshot', snapshot: snapshot()});
      case 'mode':
        runtime.planMode = m.mode === 'plan';
        if (m.mode !== 'plan' && ['ask', 'auto', 'bypass'].includes(m.mode)) await runtime.setConfig({toolApproval: m.mode});
        return send({t: 'snapshot', snapshot: snapshot()});
      case 'compact': {
        if (busy) return;
        const r = await runtime.engine.compactNow().catch((err) => ({skipped: (err as Error).message}));
        send({t: 'event', ev: {type: 'notice', text: 'skipped' in r ? `Nothing to compact: ${r.skipped}` : `Compacted ${r.summarized} messages.`}});
        return send({t: 'snapshot', snapshot: snapshot()});
      }
    }
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
