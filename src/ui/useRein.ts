import {useCallback, useEffect, useRef, useState} from 'react';
import {useApp, useInput} from 'ink';
import {detectImports, importAccounts, skipImport, type AccountRow} from '../accounts/service.js';
import {collectUsage, type UsageRow} from '../accounts/usage.js';
import {COMMANDS, parseInput, shadowedSkills, suggestCommands} from '../commands/index.js';
import {loadSkills, skillDirs, skillPrompt, type Skill} from '../skills/index.js';
import {autoUpdate, reinVersion, runUpdate, type UpdateLine} from '../commands/update.js';
import {runtime, type Resume} from '../runtime.js';
import {listTranscripts, loadTranscript, type SessionInfo} from '../session/transcript.js';
import {catalog} from '../router/catalog.js';
import {contextReport, type ContextReport} from '../session/context.js';
import {compactableCount} from '../session/compactor.js';
import {btw} from '../session/btw.js';
import type {Transcript} from '../session/transcript.js';
import type {AddEntry, Entry} from './entries.js';
import type {ApprovalDecision, ApprovalRequest} from '../tools/host.js';
import {shellStatusText, type Shell} from '../tools/shells.js';
import {subagentStatusText} from '../agents/manager.js';
import {report as agentReport} from '../agents/tools.js';
import {describeChatModel, resolveModelQuery} from './ModelScreen.js';
import {useChat} from './useChat.js';
import {Attachments} from './attachments.js';
import {mentionAt, primeFiles, suggestFiles} from './mentions.js';
import type {RewindMode, RewindPoint} from './RewindScreen.js';
import {settingsFiles} from '../tools/permissions.js';
import {readFileSync} from 'node:fs';
import {accountName, hidingIdentity} from './privacy.js';
import nodePath from 'node:path';

export const VERSION = reinVersion();

/** Queue marker: deliver a finished background subagent's report (if still uncollected). */
const DELIVER = '\u0000deliver-agent:';

export type Overlay =
  | {name: 'none'}
  | {name: 'login'}
  | {name: 'model'}
  | {name: 'configure'}
  | {name: 'approval'; req: ApprovalRequest; resolve(d: ApprovalDecision): void; position: number; total: number}
  | {name: 'import'; rows: AccountRow[]}
  // Fullscreen-only info windows (classic prints these into the transcript instead).
  | {name: 'usage'; data?: {rows: UsageRow[]; jev: boolean}}
  | {name: 'context'; report?: ContextReport}
  | {name: 'help'}
  | {name: 'shells'}
  | {name: 'resume'; sessions: SessionInfo[]}
  | {name: 'rewind'; points: RewindPoint[]}
  | {name: 'agents'}
  | {name: 'goal'}
  | {name: 'btw'; question: string; answer?: string; model?: string; mode?: 'fork' | 'context'; done?: boolean; error?: string}
  /** `auto`: opened because the agent ran a foreground command; closes itself when it ends. */
  | {name: 'shell'; id: number; auto?: boolean}
  | {name: 'update'};
export type Renderer = 'fullscreen' | 'classic';
/** Result passed to Ink's exit(): the CLI re-renders with the other renderer. */
export type ExitResult = {switchTo?: Renderer; sessionId?: string};

/**
 * Everything both renderers share: transcript entries, overlays, slash commands, autocomplete,
 * chat streaming, startup (import prompt, resume). Renderers only decide layout.
 */
export function useRein(opts: {resume: Resume; renderer: Renderer; onClear(): void}) {
  const {exit} = useApp();
  const banner = (): Entry => ({id: nextId.current++, kind: 'banner', text: `Rein ${VERSION}`});
  const nextId = useRef(0);
  const [entries, setEntries] = useState<Entry[]>(() => [banner()]);
  const [overlay, setOverlay] = useState<Overlay>({name: 'none'});
  const [ready, setReady] = useState(false);
  const [updating, setUpdating] = useState(false);
  /** Manual /compact in progress (drives the animated status line). */
  const [compacting, setCompacting] = useState<{startedAt: number; label: string} | undefined>();
  /** Update output, kept so the fullscreen update window can be closed and reopened. */
  const [updateLog, setUpdateLog] = useState<UpdateLine[]>([]);
  const windowed = opts.renderer === 'fullscreen';
  const [draft, setDraft] = useState('');
  const [suggestIndex, setSuggestIndex] = useState(0);
  /** Whose conversation the main pane shows: the main agent or a subagent (fullscreen). */
  const [view, setView] = useState<'main' | number>('main');
  const viewing = typeof view === 'number' ? runtime.agents.get(view) : undefined;
  useEffect(() => {
    // A viewed subagent that went away (e.g. /clear) → back to main.
    const onChange = () => setView((v) => (typeof v === 'number' && !runtime.agents.get(v) ? 'main' : v));
    runtime.agents.on('change', onChange);
    return () => void runtime.agents.off('change', onChange);
  }, []);
  const [skills, setSkills] = useState<Skill[]>(() => loadSkills());
  const [statusTick, setStatusTick] = useState(0);
  const bump = useCallback(() => setStatusTick((t) => t + 1), []);

  const add: AddEntry = useCallback((e) => {
    setEntries((list) => [...list, {...e, id: nextId.current++} as Entry]);
  }, []);
  const log = useCallback((kind: 'info' | 'error' | 'user', text: string) => add({kind, text}), [add]);

  const chat = useChat(add, log, {split: opts.renderer === 'classic'});

  const refresh = useCallback(async () => {
    await runtime.refreshCatalog();
    bump();
  }, [bump]);

  useEffect(() => {
    void (async () => {
      const {resumed} = await runtime.init({resume: opts.resume});
      if (resumed) replay(resumed, add);
      else if (typeof opts.resume === 'string') log('error', `No saved conversation ${opts.resume}.`);
      else if (opts.resume === true) await openResume();
      const rows = await detectImports();
      if (rows?.length) setOverlay({name: 'import', rows});
      else if (rows) await skipImport();
      await refresh();
      const shadowed = shadowedSkills(loadSkills());
      if (shadowed.length) log('info', `Skill${shadowed.length > 1 ? 's' : ''} ${shadowed.map((s) => `"${s.name}"`).join(', ')} hidden by built-in command${shadowed.length > 1 ? 's' : ''}; rename to use ${shadowed.length > 1 ? 'them' : 'it'}.`);
      setReady(true);
      // Launch-time self-update check (background; never delays startup).
      if (runtime.config.autoUpdate !== false) void autoUpdate((text) => log('info', text)).catch(() => {});
    })().catch((err) => log('error', `startup failed: ${(err as Error).message}`));
    return () => runtime.shutdown();
  }, [opts.resume, add, log, refresh]);

  // Ctrl+C: the first press stops the agent in its tracks (reply, foreground command, pending
  // approval, open window, draft); a second press within 2s exits. Exiting always takes two presses.
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  useInput((input, key) => {
    if (!(key.ctrl && input === 'c')) return;
    if (exitArmed) {
      clearTimeout(exitTimer.current);
      runtime.shutdown();
      exit();
      return;
    }
    if (chat.busy) chat.interrupt();
    else runtime.tools.shells.killForeground();
    runtime.agents.cancelAll();
    if (runtime.goals.pause()) log('info', 'Goal paused (/goal resume to continue).');
    // Deny everything waiting for approval, then close windows.
    const waiting = approvals.current;
    approvals.current = [];
    for (const a of waiting) a.resolve('deny');
    setOverlay((o) => (o.name === 'import' ? o : {name: 'none'}));
    prevDraft.current = '';
    setDraft('');
    setExitArmed(true);
    clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => setExitArmed(false), 2000);
  });

  // File changes and commands ask the user through an approval overlay. Several agents can ask at
  // once, so requests queue and are shown one at a time ("1 of 3").
  const approvals = useRef<{req: ApprovalRequest; resolve(d: ApprovalDecision): void}[]>([]);
  const showNextApproval = useCallback(() => {
    const next = approvals.current[0];
    if (!next) {
      setOverlay((o) => (o.name === 'approval' ? {name: 'none'} : o));
      return;
    }
    setOverlay({
      name: 'approval',
      req: next.req,
      position: 1,
      total: approvals.current.length,
      resolve: (d) => {
        approvals.current = approvals.current.filter((a) => a !== next);
        next.resolve(d);
        // "Allow all this session" also releases everything already waiting.
        if (d === 'session') {
          for (const a of approvals.current) a.resolve('session');
          approvals.current = [];
        }
        showNextApproval();
      },
    });
  }, []);
  useEffect(() => {
    runtime.approver = (req) =>
      new Promise<ApprovalDecision>((resolve) => {
        approvals.current.push({req, resolve});
        if (approvals.current.length === 1) showNextApproval();
        else setOverlay((o) => (o.name === 'approval' ? {...o, total: approvals.current.length} : o));
      });
    return () => {
      runtime.approver = undefined;
    };
  }, [showNextApproval]);

  // Esc stops what you're looking at: the main reply, or the viewed subagent. With a window open,
  // Esc just closes the window.
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (viewing) runtime.agents.cancel(viewing.id);
      else if (chat.busy) {
        chat.interrupt();
        if (runtime.goals.pause()) log('info', 'Goal paused (/goal resume to continue).');
      }
    },
    {isActive: overlay.name === 'none' && (viewing ? runtime.agents.isActive(viewing) : chat.busy)},
  );

  // Esc twice (idle, empty input): open /rewind, like Claude Code.
  const lastEsc = useRef(0);
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      const now = Date.now();
      if (now - lastEsc.current < 600) {
        lastEsc.current = 0;
        openRewind();
      } else lastEsc.current = now;
    },
    {isActive: overlay.name === 'none' && !viewing && !chat.busy && !draft},
  );

  /** /rewind: your messages, newest first, with how many files Rein changed since each. */
  function openRewind() {
    const points: RewindPoint[] = runtime.engine.transcript.messages
      .map((m, index) => ({m, index}))
      .filter(({m}) => m.role === 'user')
      .map(({m, index}) => ({index, at: m.at, text: displayText(m.text), files: runtime.checkpoints.changedSince(index).length}))
      .reverse();
    setOverlay({name: 'rewind', points});
  }

  const doRewind = async (index: number, mode: RewindMode) => {
    setOverlay({name: 'none'});
    if (chat.busy) chat.interrupt();
    const t = runtime.engine.transcript;
    const text = t.messages[index]?.text ?? '';
    if (mode !== 'conversation') {
      const r = runtime.checkpoints.restore(index);
      const n = r.restored.length + r.removed.length;
      log('info', `Rewound ${n} file${n === 1 ? '' : 's'}${r.removed.length ? ` (${r.removed.length} created since were removed)` : ''}${r.skipped.length ? ` · ${r.skipped.length} too large to restore: ${r.skipped.join(', ')}` : ''}.`);
    }
    if (mode !== 'code') {
      await runtime.engine.rewind(index);
      opts.onClear();
      setEntries([banner()]);
      replay(runtime.engine.transcript, add);
      prevDraft.current = displayText(text);
      setDraft(displayText(text)); // edit and resend
      log('info', 'Conversation rewound — your message is back in the input.');
    }
    bump();
  };

  const suggestions = suggestCommands(draft, skills);
  const selected = suggestions[Math.min(suggestIndex, suggestions.length - 1)];
  // @file mentions: project files matching what follows the `@` being typed.
  const mention = suggestions.length ? undefined : mentionAt(draft);
  const fileSuggestions = mention ? suggestFiles(process.cwd(), mention.query) : [];
  const fileSelected = fileSuggestions[Math.min(suggestIndex, fileSuggestions.length - 1)];
  const acceptFile = (file: string) => {
    if (!mention) return;
    const next = `${draft.slice(0, mention.start)}@${file}${file.endsWith('/') ? '' : ' '}`;
    prevDraft.current = next;
    setDraft(next);
    setSuggestIndex(0);
  };
  // The input stays live while the agent works: /btw and info commands run at once, plain messages queue.
  const inputActive = overlay.name === 'none' && ready && (!updating || windowed);
  const [queued, setQueued] = useState<string[]>([]);
  const runRef = useRef<(raw: string) => void>(() => {});
  const pendingDelivery = useRef(new Set<number>());

  // Background subagents that finish while their report is uncollected are delivered to the main
  // agent as a message (queued behind the current turn), so it can work alongside them or end its
  // turn and be woken up with the results.
  useEffect(() => {
    const onChange = () => {
      for (const a of runtime.agents.list()) {
        if (!a.background || a.collected || runtime.agents.isActive(a) || a.rounds === 0 || pendingDelivery.current.has(a.id)) continue;
        // Decide at delivery time: the main agent may still collect it via agent_result first.
        pendingDelivery.current.add(a.id);
        setQueued((q) => [...q, `${DELIVER}${a.id}`]);
      }
    };
    runtime.agents.on('change', onChange);
    return () => void runtime.agents.off('change', onChange);
  }, []);

  // Goal loop: whenever a turn ends with an active goal (and nothing queued or awaiting approval),
  // ask the goal manager what to send next — a continuation, or input from the advisor/a subagent
  // when the agent gave up. Stops when the goal is done, paused or cleared.
  const goalBusy = useRef(false);
  const [goalNote, setGoalNote] = useState<{startedAt: number; label: string} | undefined>();
  const announced = useRef<number | undefined>(undefined);
  useEffect(() => {
    const g = runtime.goals.goal;
    if (g?.status === 'done' && g.doneAt && announced.current !== g.doneAt) {
      announced.current = g.doneAt;
      log('info', `◎ Goal achieved and verified: ${g.text}\n${g.checks.at(-1)?.verdict ?? ''}`);
      runtime.engine.refreshTools(); // goal_done goes away
    }
    if (!ready || chat.busy || goalBusy.current || queued.length || overlay.name === 'approval' || g?.status !== 'active') return;
    // Background subagents still working: wait for their reports instead of nudging the agent.
    if (runtime.agents.running({background: true}).some((a) => !a.collected)) return;
    goalBusy.current = true;
    setGoalNote({startedAt: Date.now(), label: 'Goal: checking progress'});
    void runtime.goals
      .next()
      .then((step) => {
        const now = runtime.goals.goal;
        if (!step || now?.status !== 'active') {
          if (now?.status === 'paused') log('info', `Goal paused: ${now.checks.at(-1)?.verdict ?? 'by request'}`);
          return;
        }
        log('info', step.note);
        void chat.send(step.message).then(bump);
      })
      .catch((err) => log('error', `Goal loop failed: ${(err as Error).message}`))
      .finally(() => {
        goalBusy.current = false;
        setGoalNote(undefined);
      });
  }, [chat.busy, queued.length, overlay.name, ready, statusTick]);
  useEffect(() => {
    if (chat.busy || !queued.length) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    if (next!.startsWith(DELIVER)) {
      const a = runtime.agents.get(Number(next!.slice(DELIVER.length)));
      if (a) pendingDelivery.current.delete(a.id);
      if (!a || a.collected) return; // already collected via agent_result
      a.collected = true;
      log('info', `Subagent ${a.name} finished (${a.status}) — its report goes to the main agent.`);
      void chat.send(`<subagent_report id="${a.id}" name="${a.name}" status="${a.status}">\n${agentReport(a)}\n</subagent_report>\nContinue with this result.`).then(bump);
      return;
    }
    runRef.current(next!); // through the normal path, so queued skills expand
  }, [chat.busy, queued]);

  const prevDraft = useRef('');
  // Pastes, images and dropped files shown as placeholders in the input; expanded on send.
  const attachments = useRef(new Attachments(() => nodePath.join(runtime.engine.scratch, 'images')));
  const onPaste = (text: string) => attachments.current.paste(text);
  const onImagePaste = async () => {
    const token = await attachments.current.pasteClipboardImage();
    if (!token) log('info', 'No image on the clipboard (Ctrl+V pastes images; drag a file in to attach it).');
    return token;
  };
  const onDraft = useCallback((v: string) => {
    if (mentionAt(v) && !mentionAt(prevDraft.current)) void primeFiles(process.cwd()).then(bump);
    // Rescan skills whenever a slash command is started, so new/edited skills show up without restarting.
    if (v.startsWith('/') && !prevDraft.current.startsWith('/')) setSkills(loadSkills());
    prevDraft.current = v;
    setDraft(v);
    setSuggestIndex(0);
  }, []);

  useInput(
    (_input, key) => {
      if (key.upArrow) setSuggestIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
      else if (key.downArrow) setSuggestIndex((i) => (i + 1) % suggestions.length);
      else if (key.tab && selected) onDraft(`/${selected.name} `);
    },
    {isActive: inputActive && suggestions.length > 0},
  );
  useInput(
    (_input, key) => {
      if (key.upArrow) setSuggestIndex((i) => (i - 1 + fileSuggestions.length) % fileSuggestions.length);
      else if (key.downArrow) setSuggestIndex((i) => (i + 1) % fileSuggestions.length);
      else if (key.tab && fileSelected) acceptFile(fileSelected);
    },
    {isActive: inputActive && fileSuggestions.length > 0},
  );

  const runCommand = (raw: string) => {
    const parsed = parseInput(raw, skills);
    if (!parsed) return;
    if (parsed.kind === 'skill') {
      if (chat.busy) {
        log('info', 'The agent is working — the skill will run after it finishes.');
        setQueued((q) => [...q, raw.trim()]);
        return;
      }
      log('user', raw.trim());
      if (!catalog.all().length) {
        log('error', 'No signed-in accounts. Use /login to add one.');
        return;
      }
      const args = attachments.current.expand(parsed.args);
      void chat.send(skillPrompt(parsed.skill, args.text), args.images).then(bump);
      return;
    }
    if (parsed.kind === 'text' && viewing) {
      // Viewing a subagent: the message goes to it.
      const msg = attachments.current.expand(parsed.text);
      if (msg.images.length) log('info', 'Images can only be sent to the main agent; the subagent gets the text.');
      void runtime.agents.message(viewing.id, msg.text).catch((err) => log('error', (err as Error).message));
      return;
    }
    if (parsed.kind === 'text') {
      if (chat.busy) {
        // Sent when the current reply finishes (shown as "N queued" on the status line).
        setQueued((q) => [...q, parsed.text]);
        return;
      }
      log('user', parsed.text);
      if (!catalog.all().length) {
        log('error', 'No signed-in accounts. Use /login to add one.');
        return;
      }
      const msg = attachments.current.expand(parsed.text);
      void chat.send(msg.text, msg.images).then(bump);
      return;
    }
    if (parsed.kind === 'unknown') {
      log('error', `Unknown command /${parsed.name}. Try /help.`);
      return;
    }
    if (chat.busy && ['clear', 'compact', 'tui', 'update', 'resume'].includes(parsed.name)) {
      log('info', `/${parsed.name} waits until the agent is idle (esc interrupts it).`);
      return;
    }
    // In fullscreen, commands that open a window don't echo into the history.
    const opensWindow = ['login', 'usage', 'context', 'help', 'update', 'configure', 'shells', 'btw', 'resume', 'agents', 'agent'].includes(parsed.name) || (parsed.name === 'model' && !parsed.args);
    if (!(windowed && opensWindow)) log('user', raw.trim());
    switch (parsed.name) {
      case 'rewind':
        if (chat.busy) {
          log('info', 'The agent is working — press esc to stop it first, then /rewind.');
          break;
        }
        openRewind();
        break;
      case 'permissions': {
        const lines: string[] = [];
        for (const file of settingsFiles(process.cwd())) {
          let p: any;
          try {
            p = JSON.parse(readFileSync(file, 'utf8'))?.permissions;
          } catch {
            continue;
          }
          if (!p?.allow?.length && !p?.deny?.length) continue;
          lines.push(file);
          for (const r of p.allow ?? []) lines.push(`  allow ${r}`);
          for (const r of p.deny ?? []) lines.push(`  deny  ${r}`);
        }
        log('info', lines.length ? `Permission rules (deny wins):\n${lines.join('\n')}` : 'No permission rules yet. Choose "3 Always allow" in an approval prompt, or add "permissions": {"allow": [...], "deny": [...]} to .rein/settings.json (Claude Code format; .claude/settings.json rules apply too).');
        break;
      }
      case 'add-dir': {
        const arg = parsed.args.trim();
        if (!arg) {
          log('info', `Working directories:\n${runtime.tools.workingDirs().map((d) => `  ${d}`).join('\n')}\nOther paths need approval. /add-dir <path> adds one for this session (or set additionalDirectories in ~/.rein/config.json).`);
          break;
        }
        try {
          const added = runtime.tools.addDirs([arg]);
          log('info', added.length ? `Added working directory ${added[0]} for this session.` : `${arg} is already a working directory.`);
        } catch (err) {
          log('error', (err as Error).message);
        }
        break;
      }
      case 'goal': {
        const arg = parsed.args.trim();
        const g = runtime.goals.goal;
        const sub = arg.toLowerCase();
        if (!arg) {
          if (!g) log('info', 'No goal set. /goal <text> sets one; the agent works until the decision model verifies it is done.');
          else if (windowed) setOverlay({name: 'goal'});
          else log('info', goalSummary(g));
          break;
        }
        if (sub === 'pause') {
          log('info', runtime.goals.pause() ? 'Goal paused — the current turn finishes, then the agent stops. /goal resume continues.' : g ? `The goal is ${g.status}.` : 'No goal set.');
          break;
        }
        if (sub === 'resume') {
          if (!runtime.goals.resume()) {
            log('info', g ? `The goal is ${g.status}.` : 'No goal set.');
            break;
          }
          runtime.engine.refreshTools();
          log('info', `Goal resumed: ${g!.text}`);
          bump(); // wakes the goal loop
          break;
        }
        if (sub === 'clear') {
          log('info', runtime.goals.clear() ? 'Goal cleared.' : 'No goal set.');
          runtime.engine.refreshTools();
          bump();
          break;
        }
        const goal = runtime.goals.set(arg);
        log('info', `◎ Goal set: ${arg}\nThe agent keeps working until the decision model verifies it's done (evidence required). /goal pause · resume · clear`);
        const kick = runtime.goals.kickoff(goal);
        if (chat.busy) setQueued((q) => [...q, kick]);
        else {
          runtime.engine.refreshTools(); // goal_done becomes available
          void chat.send(kick).then(bump);
        }
        break;
      }
      case 'btw': {
        const question = parsed.args.trim();
        if (!question) {
          log('info', 'Usage: /btw <question> — answered from the conversation without interrupting the agent.');
          break;
        }
        if (windowed) setOverlay({name: 'btw', question});
        else log('info', `btw: ${question} (answering…)`);
        const patch = (p: Partial<Extract<Overlay, {name: 'btw'}>>) =>
          setOverlay((o) => (o.name === 'btw' && o.question === question ? {...o, ...p} : o));
        void (async () => {
          let answer = '';
          let info: {mode?: 'fork' | 'context'; model?: string} = {};
          let last = 0;
          try {
            for await (const ev of btw(runtime.engine, runtime.config, question)) {
              if (ev.type === 'mode') info = {mode: ev.mode, model: ev.model};
              else answer += ev.delta;
              // Stream into the window, ~15 updates/s.
              if (windowed && Date.now() - last > 66) {
                last = Date.now();
                patch({answer, ...info});
              }
            }
            if (windowed) patch({answer, ...info, done: true});
            else log('info', `btw → ${answer.trim()}\n(${info.model ?? 'model'} · ${info.mode === 'fork' ? 'forked agent' : 'from conversation'} · not added to the conversation)`);
          } catch (err) {
            if (windowed) patch({error: (err as Error).message, done: true});
            else log('error', `btw failed: ${(err as Error).message}`);
          }
        })();
        break;
      }
      case 'login':
        setOverlay({name: 'login'});
        break;
      case 'model': {
        if (!parsed.args) {
          setOverlay({name: 'model'});
          break;
        }
        const value = resolveModelQuery(parsed.args);
        if (!value) {
          log('error', `Unknown model "${parsed.args}". Try /model to pick from the list.`);
          break;
        }
        void runtime.setConfig({chatModel: value}).then(() => {
          log('info', `Chat model: ${describeChatModel(value)}`);
          bump();
        });
        break;
      }
      case 'usage': {
        const force = /^refresh$/i.test(parsed.args);
        if (windowed) {
          setOverlay({name: 'usage'});
          void collectUsage({force}).then((data) => {
            setOverlay((o) => (o.name === 'usage' ? {name: 'usage', data} : o));
            bump();
          });
          break;
        }
        log('info', force ? 'Refreshing usage (Claude accounts send a tiny request on their cheapest model)…' : 'Checking usage…');
        void collectUsage({force}).then(({rows, jev}) => {
          add({kind: 'usage', rows, jev});
          bump();
        });
        break;
      }
      case 'context':
        if (windowed) {
          setOverlay({name: 'context'});
          void contextReport(runtime.engine, runtime.config, runtime.tools.specs({includeMainOnly: true})).then(
            (report) => setOverlay((o) => (o.name === 'context' ? {name: 'context', report} : o)),
            (err) => log('error', `Context unavailable: ${(err as Error).message}`),
          );
          break;
        }
        void contextReport(runtime.engine, runtime.config, runtime.tools.specs({includeMainOnly: true})).then(
          (report) => add({kind: 'context', report}),
          (err) => log('error', `Context unavailable: ${(err as Error).message}`),
        );
        break;
      case 'compact': {
        if (!runtime.engine.transcript.messages.length) {
          log('info', 'Nothing to compact yet.');
          break;
        }
        const n = compactableCount(runtime.engine.transcript, 2);
        if (!n) {
          log('info', 'Nothing to compact yet — the last couple of messages are always kept as-is.');
          break;
        }
        setCompacting({startedAt: Date.now(), label: `Compacting ${n} messages`});
        void runtime.engine
          .compactNow()
          .then(
            (res) => {
              if ('skipped' in res) log('info', `Nothing to compact: ${res.skipped}`);
              else add({kind: 'compact', reason: 'manual', result: res});
            },
            (err) => log('error', `Compaction failed: ${(err as Error).message}`),
          )
          .finally(() => {
            setCompacting(undefined);
            bump();
          });
        break;
      }
      case 'update': {
        if (updating) {
          if (windowed) setOverlay({name: 'update'});
          else log('info', 'An update is already running.');
          break;
        }
        setUpdating(true);
        setUpdateLog([]);
        if (windowed) setOverlay({name: 'update'});
        void (async () => {
          try {
            for await (const line of runUpdate(() => runtime.engine.shutdown())) {
              if (windowed) setUpdateLog((l) => [...l, line]);
              else add({kind: 'update', line});
            }
          } catch (err) {
            log('error', `Update failed: ${(err as Error).message}`);
          } finally {
            await refresh();
            setUpdating(false);
          }
        })();
        break;
      }
      case 'tui': {
        const want = parsed.args.trim().toLowerCase();
        if (want !== 'fullscreen' && want !== 'classic') {
          log('info', `Renderer: ${opts.renderer}. Use /tui fullscreen or /tui classic.`);
          break;
        }
        if (want === opts.renderer) {
          log('info', `Already using the ${want} renderer.`);
          break;
        }
        void runtime.setConfig({tui: want}).then(() => exit({switchTo: want, sessionId: runtime.engine.transcript.messages.length ? runtime.engine.transcript.id : undefined} satisfies ExitResult));
        break;
      }
      case 'configure':
        setOverlay({name: 'configure'});
        break;
      case 'agents': {
        const all = runtime.agents.list();
        if (windowed) {
          if (!all.length) log('info', 'No subagents yet — the agent spawns them with its agent tool.');
          else setOverlay({name: 'agents'});
          break;
        }
        log('info', all.length ? all.map((a) => `#${a.id} ${a.name} · ${a.modelLabel ?? a.requested} · ${a.mode} · ${subagentStatusText(a)}`).join('\n') + '\n/agent <id> shows a report · /agent <id> <message> talks to it' : 'No subagents yet.');
        break;
      }
      case 'agent': {
        const [first = '', ...rest] = parsed.args.trim().split(/\s+/);
        if (!first || first === 'main') {
          setView('main');
          break;
        }
        const a = runtime.agents.get(Number(first.replace('#', '')));
        if (!a) {
          log('error', `No subagent ${first}. /agents lists them.`);
          break;
        }
        if (windowed && !rest.length) {
          setView(a.id);
          break;
        }
        if (rest.length) void runtime.agents.message(a.id, rest.join(' ')).catch((err) => log('error', (err as Error).message));
        else log('info', `#${a.id} ${a.name} · ${a.modelLabel ?? a.requested} · ${subagentStatusText(a)}\nTask: ${a.task}\n\n${a.output || '(no report yet)'}`);
        break;
      }
      case 'resume':
        void openResume();
        break;
      case 'shells': {
        const shells = runtime.tools.shells.list();
        const id = Number(parsed.args.replace('#', ''));
        if (windowed) {
          if (parsed.args && shells.some((s) => s.id === id)) setOverlay({name: 'shell', id});
          else openShells();
          break;
        }
        if (parsed.args && shells.some((s) => s.id === id)) {
          const s = runtime.tools.shells.get(id)!;
          log('info', `#${s.id} ${shellStatusText(s)} · ${s.command}\n${runtime.tools.shells.tail(s, 40) || '(no output)'}`);
        } else {
          log('info', shells.length ? shells.map((s) => `#${s.id} ${s.background ? 'background' : 'foreground'} · ${shellStatusText(s)} · ${s.command}`).join('\n') + '\n/shells <id> shows logs' : 'No shells yet.');
        }
        break;
      }
      case 'help':
        if (!windowed && skills.length) {
          log('info', `Skills (built-in → ${skillDirs().project} → ${skillDirs().global}):\n` + skills.map((s) => `/${s.name.padEnd(12)} ${s.description} (${s.source})`).join('\n'));
        }
        if (windowed) {
          setOverlay({name: 'help'});
          break;
        }
        log('info', COMMANDS.map((c) => `/${c.name.padEnd(8)} ${c.description}`).join('\n') + '\nesc interrupts a reply · rein --continue picks a conversation to continue');
        break;
      case 'clear':
        runtime.agents.closeAll();
        setView('main');
        runtime.engine.reset();
        setEntries([banner()]);
        opts.onClear();
        break;
      case 'exit':
        runtime.shutdown();
        exit();
        break;
    }
  };

  runRef.current = runCommand;

  const onSubmit = (typed: string) => {
    // Enter while picking an @file accepts it (unless it's already typed out in full).
    if (fileSelected && mention && mention.query !== fileSelected) {
      acceptFile(fileSelected);
      return;
    }
    prevDraft.current = '';
    setDraft('');
    setSuggestIndex(0);
    // Enter on a partial command runs the highlighted suggestion (like Claude Code).
    const partial = suggestCommands(typed, skills);
    const exact = partial.some((c) => `/${c.name}` === typed.trim().toLowerCase());
    runCommand(partial.length && !exact ? `/${(partial[Math.min(suggestIndex, partial.length - 1)] ?? partial[0]!).name}` : typed);
  };

  const finishImport = (accept: boolean) => {
    if (overlay.name !== 'import') return;
    const rows = overlay.rows;
    setOverlay({name: 'none'});
    if (accept) {
      void importAccounts(rows).then(async () => {
        log('info', `Imported ${rows.map((r) => (hidingIdentity() ? accountName(r.account, rows.map((x) => x.account)) : r.status.loggedIn ? r.status.email : r.account.id)).join(', ')}`);
        await refresh();
      });
    } else {
      void skipImport();
      log('info', 'Skipped import. Use /login to add accounts.');
    }
  };

  /** `rein --continue` / `/resume`: saved conversations for this project. */
  async function openResume() {
    const sessions = (await listTranscripts({cwd: process.cwd()})).filter((s) => s.id !== runtime.engine?.transcript.id);
    if (!sessions.length) {
      log('info', 'No saved conversations in this project yet.');
      return;
    }
    setOverlay({name: 'resume', sessions});
  }

  /** Continue a saved conversation: load it into the engine and redraw its recent history. */
  const pickSession = async (id: string) => {
    setOverlay({name: 'none'});
    const t = await loadTranscript(id);
    if (!t) return log('error', `Couldn't load conversation ${id}.`);
    runtime.engine.load(t);
    opts.onClear();
    setEntries([banner()]);
    replay(t, add);
    bump();
  };

  /** Status-line click / `/shells`: one background process → its logs directly, else the list. */
  const openShells = () => {
    const bg = runtime.tools.shells.list().filter((s) => s.background);
    const running = bg.filter((s) => s.status === 'running');
    if (running.length === 1) setOverlay({name: 'shell', id: running[0]!.id});
    else if (!running.length && bg.length === 1) setOverlay({name: 'shell', id: bg[0]!.id});
    else setOverlay({name: 'shells'});
  };

  // Foreground commands: pop the live output window (fullscreen), close it shortly after they end.
  useEffect(() => {
    if (!windowed) return;
    const shells = runtime.tools.shells;
    const onForeground = (s: Shell) =>
      // Subagent commands show in the subagent's view, not as a popup over the main agent.
      !s.origin &&
      setOverlay((o) => (o.name === 'none' || o.name === 'shells' || o.name === 'shell' ? {name: 'shell', id: s.id, auto: true} : o));
    const onChange = (s: Shell) => {
      if (s.background || s.status === 'running') return;
      setTimeout(() => setOverlay((o) => (o.name === 'shell' && o.id === s.id && o.auto ? {name: 'none'} : o)), 1500);
    };
    shells.on('foreground', onForeground);
    shells.on('change', onChange);
    return () => {
      shells.off('foreground', onForeground);
      shells.off('change', onChange);
    };
  }, [windowed]);

  const closeOverlay = () => {
    setOverlay({name: 'none'});
    void refresh();
  };

  return {
    entries, add, log, overlay, setOverlay, closeOverlay, finishImport, ready, updating, updateLog, statusTick, bump,
    draft, onDraft, onSubmit, onPaste, onImagePaste, doRewind, fileSuggestions, fileSelected, acceptFile, runCommand, suggestions, selected, setSuggestIndex, inputActive, chat, skills, openShells, queued, exitArmed, compacting, pickSession,
    view, setView, viewing, goalNote,
  };
}

/** Show the last few turns of a resumed conversation. */
/** A stored user message as the user typed it (skill prompts back to `/name args`). */
export const displayText = (text: string) => text.replace(/^<skill name="([^"]+)"[\s\S]*?<\/skill>\s*/, '/$1 ');

function replay(t: Transcript, add: AddEntry): void {
  const recent = t.messages.slice(-10);
  add({kind: 'info', text: t.messages.length > recent.length ? `Resumed conversation (${t.messages.length} messages; showing the last ${recent.length})` : 'Resumed conversation'});
  for (const m of recent) {
    if (m.role === 'user') add({kind: 'user', text: displayText(m.text)});
    else {
      for (const tool of m.tools ?? []) add({kind: 'tool', ...tool});
      add({kind: 'assistant', text: m.text, first: true});
    }
  }
}

export function goalSummary(g: import('../goals/manager.js').Goal): string {
  const lines = [`◎ ${g.text}`, `status: ${g.status} · ${g.rounds} continuation${g.rounds === 1 ? '' : 's'} · ${g.escalations} escalation${g.escalations === 1 ? '' : 's'}`];
  for (const c of g.checks.slice(-8)) lines.push(`  ${new Date(c.at).toLocaleTimeString()} ${c.kind === 'claim' ? 'done claim' : 'turn'}: ${c.verdict}`);
  return lines.join('\n');
}
