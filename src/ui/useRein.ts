import {useCallback, useEffect, useRef, useState} from 'react';
import {useApp, useInput} from 'ink';
import {detectImports, importAccounts, skipImport, type AccountRow} from '../accounts/service.js';
import {type UsageRow} from '../accounts/usage.js';
import {shadowedSkills, suggestCommands} from '../commands/index.js';
import {runCommand as runCommandWith} from '../commands/run.js';
export {goalSummary} from '../commands/run.js';
import {loadSkills, type Skill} from '../skills/index.js';
import {autoUpdate, reinVersion, type UpdateLine} from '../commands/update.js';
import {runtime, type Resume} from '../runtime.js';
import {listTranscripts, loadTranscript, type SessionInfo} from '../session/transcript.js';
import {catalog} from '../router/catalog.js';
import {extensions} from '../extensions/index.js';
import {subagentContextReport, contextReport, type ContextReport} from '../session/context.js';
import {onUntrustedHooks, trustProjectHooks, type ProjectHooks} from '../hooks.js';
import {notify} from './terminal/notify.js';
import {incompatibleMessage} from '../providers/codex/compat.js';
import {sandboxBackend} from '../tools/sandbox.js';
import {findIdes} from '../ide/connection.js';
import {diffTabName, proposedChange} from '../ide/review.js';
import {takeOver} from './terminal/takeover.js';
import {preloadPty} from '../tools/shells.js';
import {rmSync} from 'node:fs';
import {PushToTalk, voiceKeys, type VoiceKeyEvent} from './terminal/voiceKey.js';
import {DEFAULT_MODEL, detect, installHint, MAX_RECORD_SECONDS, Recording, transcribe} from '../voice/voice.js';
import {RemoteServer, type RemoteState} from '../remote/server.js';
import {parseRef} from '../providers/types.js';
import type {EngineEvent} from '../session/engine.js';
import {editExternally} from './terminal/editor.js';
import {addHistory, HistoryCursor, loadHistory} from '../store/history.js';
import type {Transcript} from '../session/transcript.js';
import type {AddEntry, Entry} from './entries.js';
import type {ApprovalDecision, ApprovalRequest} from '../tools/host.js';
import {dueForCheck, stillNeeded} from '../tools/backgroundCheck.js';
import {shellStatusText, type Shell} from '../tools/shells.js';
import {report as agentReport} from '../agents/tools.js';
import {useChat} from './useChat.js';
import {Attachments} from './attachments.js';
import {mentionAt, primeFiles, suggestFiles} from './mentions.js';
import type {RewindMode, RewindPoint} from './RewindScreen.js';
import type {PlanDecision, PresentedPlan} from '../tools/plan.js';
import {type SavedPlan} from '../plans/store.js';
import {planPreview} from './planPreview.js';
import type {AskAnswer, AskQuestion} from '../tools/ask.js';
import {accountName, hidingIdentity} from './privacy.js';
import nodePath from 'node:path';
import {removeLive, watchInbox, writeLive} from '../host/live.js';

/** /goal waiting for its confirmation (its estimate was above goalConfirmUsd). */

export const VERSION = reinVersion();

/** Queue marker: deliver a finished background subagent's report (if still uncollected). */
const DELIVER = '\u0000deliver-agent:';

/** Work shorter than this finishes without a notification (you're probably still watching). */
const NOTIFY_AFTER_MS = 20_000;
/** Background commands running at least this long are mentioned (once) when a turn ends. */
const BACKGROUND_REMINDER_MS = 5 * 60_000;

export type VoiceState = 'idle' | 'holding' | 'recording' | 'transcribing';
export const voiceNote = (v: VoiceState) =>
  v === 'holding'
    ? '● Recording… let go of Ctrl+Space to stop · Ctrl+C cancels'
    : v === 'recording'
      ? `● Recording… press Ctrl+Space to stop (up to ${MAX_RECORD_SECONDS / 60} min) · Ctrl+C cancels`
      : 'Transcribing…';

export type Overlay =
  | {name: 'none'}
  | {name: 'login'}
  /** `/vault set NAME`: enter the value, hidden. */
  | {name: 'vault'; secret: string}
  | {name: 'model'}
  | {name: 'settings'; tab?: string}
  | {name: 'approval'; req: ApprovalRequest; resolve(d: ApprovalDecision): void; position: number; total: number}
  | {name: 'import'; rows: AccountRow[]}
  | {name: 'trust'; hooks: ProjectHooks}
  /** Ctrl+R: search the messages sent in this project. */
  | {name: 'history'; entries: string[]}
  // Fullscreen-only info windows (classic prints these into the transcript instead).
  | {name: 'usage'; data?: {rows: UsageRow[]; jev: boolean}}
  | {name: 'context'; report?: ContextReport; agent?: string}
  | {name: 'help'}
  | {name: 'shells'}
  | {name: 'resume'; sessions: SessionInfo[]}
  | {name: 'rewind'; points: RewindPoint[]}
  | {name: 'mcp'}
  | {name: 'text'; title: string; lines: string[]}
  | {name: 'marketplace'}
  | {name: 'marketplace-updates'; items: import('../marketplace/index.js').Item[]; updates: {id: string; from: string; to: string}[]}
  | {name: 'plan'; plan: PresentedPlan; resolve(d: PlanDecision): void}
  | {name: 'plans'; plans: SavedPlan[]}
  | {name: 'ask'; questions: AskQuestion[]; resolve(a: AskAnswer[] | undefined): void}
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
  const entriesNow = useRef(entries);
  entriesNow.current = entries;
  /**
   * While a command has the terminal (takeover.ts), Rein's drawing is dropped. The classic
   * transcript is printed once per entry (<Static>), so entries added meanwhile would never appear:
   * it shows only the first `terminalHold` entries until the command hands the terminal back.
   */
  const terminalHold = useRef<number | undefined>(undefined);
  const [, setHoldTick] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>({name: 'none'});
  const [ready, setReady] = useState(false);
  const [updating, setUpdating] = useState(false);
  /** Manual /compact in progress (drives the animated status line). */
  const [compacting, setCompacting] = useState<{startedAt: number; label: string; idle?: boolean} | undefined>();
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
  // An item's code registered or changed something it draws: draw again.
  useEffect(() => {
    const on = () => setStatusTick((t) => t + 1);
    extensions.on('change', on);
    return () => void extensions.off('change', on);
  }, []);
  const [statusTick, setStatusTick] = useState(0);
  const bump = useCallback(() => setStatusTick((t) => t + 1), []);

  const add: AddEntry = useCallback((e) => {
    setEntries((list) => [...list, {...e, id: nextId.current++} as Entry]);
  }, []);
  const log = useCallback((kind: 'info' | 'error' | 'user', text: string) => add({kind, text}), [add]);
  const logMain = log;

  const chat = useChat(add, log, {split: opts.renderer === 'classic'});
  const chatRef = useRef(chat);
  chatRef.current = chat;

  // Project hooks run only once trusted: ask as soon as untrusted ones are skipped (at startup, or
  // when they change mid-session), after any window that's open closes.
  const [untrusted, setUntrusted] = useState<ProjectHooks | undefined>();
  useEffect(() => {
    onUntrustedHooks((p) => setUntrusted(p));
    return () => onUntrustedHooks(undefined);
  }, []);
  useEffect(() => {
    if (untrusted && overlay.name === 'none') {
      setOverlay({name: 'trust', hooks: untrusted});
      setUntrusted(undefined);
    }
  }, [untrusted, overlay.name]);
  const finishTrust = (trust: boolean) => {
    if (overlay.name !== 'trust') return;
    setOverlay({name: 'none'});
    if (!trust) {
      log('info', "This project's hooks won't run this session. You'll be asked again next time.");
      return;
    }
    trustProjectHooks(process.cwd());
    log('info', `Trusted this project's hooks (${overlay.hooks.commands.length}). They run from now on; any change to them asks again.`);
    void runtime.sessionStartHooks('startup', true);
  };

  /** The first model listing (startup); messages sent before it finishes wait for it. */
  const catalogReady = useRef<Promise<void> | undefined>(undefined);
  const refresh = useCallback(async () => {
    await runtime.refreshCatalog();
    bump();
    // Claude models' real context windows, for those never used yet (interactive sessions only).
    void catalog.probeWindows().then(bump);
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
      // Typing starts now: listing the models starts the CLIs (a Codex app-server per account), so it
      // goes on in the background and a message sent before it's done waits for it (onSubmit).
      setReady(true);
      const listed = refresh();
      catalogReady.current = listed.catch(() => {});
      await listed;
      // Your pet from the ChatGPT and Codex apps: found in the background (it starts a codex app-server).
      void runtime.loadPets().then(() => runtime.pets.setActivity('hello'), () => {});
      // Marketplace items' code: their commands, tools, sidebar sections, status segments and themes.
      void runtime.loadExtensions().then((r) => {
        for (const f of r.failed) log('error', `The marketplace item ${f.id} didn't load: ${f.error}`);
      }, (err) => log('error', `Marketplace items didn't load: ${(err as Error).message}`));
      // A codex whose app-server protocol changed under Rein is switched off (see compat.ts).
      const compat = catalog.codexCompat;
      if (compat?.ok === false) log('error', incompatibleMessage(compat));
      else for (const w of compat?.warnings ?? []) log('info', `Codex ${compat!.version}: ${w}`);
      const shadowed = shadowedSkills(loadSkills());
      if (shadowed.length) log('info', `Skill${shadowed.length > 1 ? 's' : ''} ${shadowed.map((s) => `"${s.name}"`).join(', ')} hidden by built-in command${shadowed.length > 1 ? 's' : ''}; rename to use ${shadowed.length > 1 ? 'them' : 'it'}.`);
      // Issue trackers: only an interactive session takes issues (their approvals need someone).
      runtime.trackerLog = (text, kind) => log(kind ?? 'info', text);
      runtime.trackers.start();
      // Project MCP servers wait for approval (a repo shouldn't launch commands on its own).
      setTimeout(() => {
        const waiting = runtime.mcp.list().filter((s) => s.status === 'needs-approval').map((s) => s.name);
        if (waiting.length) log('info', `This project's .mcp.json has MCP server${waiting.length > 1 ? 's' : ''} waiting for your approval: ${waiting.join(', ')} — /mcp to review.`);
        const changed = runtime.mcp.list().filter((s) => s.status === 'changed').map((s) => s.name);
        if (changed.length) log('error', `MCP server${changed.length > 1 ? 's' : ''} ${changed.join(', ')} changed since you approved ${changed.length > 1 ? 'them' : 'it'}; ${changed.length > 1 ? 'their' : 'its'} tools are held until you review ${changed.length > 1 ? 'them' : 'it'} in /mcp.`);
        const signIn = runtime.mcp.list().filter((s) => s.status === 'needs-auth').map((s) => s.name);
        if (signIn.length) log('info', `MCP server${signIn.length > 1 ? 's' : ''} ${signIn.join(', ')} need${signIn.length > 1 ? '' : 's'} you to sign in — /mcp, then enter.`);
      }, 1500);
      // The sandbox is on by default; say so once where this machine can't provide one.
      if ((runtime.config.sandbox ?? 'write') !== 'off' && !sandboxBackend())
        log('info', process.platform === 'win32' ? "The command sandbox isn't available on Windows: the agent's commands run unsandboxed (approvals still apply)." : process.platform === 'linux' ? "The command sandbox needs bubblewrap (install the 'bubblewrap' package): until then the agent's commands run unsandboxed." : "The command sandbox isn't available here: the agent's commands run unsandboxed.");
      // Subagent work left in worktrees by a Rein that exited mid-task: merge it home now.
      void runtime.worktrees.recover().then((results) => {
        for (const r of results) {
          if (r.merged.length) log('info', `Merged unfinished subagent work from the last session into the project: ${r.merged.slice(0, 8).join(', ')}${r.merged.length > 8 ? ` and ${r.merged.length - 8} more` : ''}.`);
          if (r.conflicts.length) log('info', `Some unfinished subagent work conflicts with your changes and wasn't merged: ${r.conflicts.join(', ')}. Its versions are in ${r.kept}.`);
        }
      }, () => {});
      // Editor integration: connect quietly to the editor holding this project, if there is one.
      if (findIdes().length) void runtime.connectIde().then((m) => log('info', m), () => {});
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
    if (cancelVoice()) log('info', 'Recording cancelled.');
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

  // Interactive commands (shell interactive: true): when one waits for the user, it gets the real
  // terminal until it exits or the user presses Ctrl+] (which also reopens it). See takeover.ts.
  const takeoverEnd = useRef<(() => void) | undefined>(undefined);
  const openTerminal = useCallback(
    (shell: Shell) => {
      if (takeoverEnd.current || shell.background || !shell.tty || shell.status !== 'running') return;
      terminalHold.current = entriesNow.current.length;
      takeoverEnd.current = takeOver(runtime.tools.shells, shell, {
        fullscreen: windowed,
        label: shell.origin?.name,
        onEnd: (reason) => {
          takeoverEnd.current = undefined;
          terminalHold.current = undefined;
          setHoldTick((n) => n + 1); // draw what was held
          if (reason === 'detach' && shell.status === 'running') log('info', `$ ${shell.command} is still running · ctrl+] to type into it again`);
        },
      });
    },
    [windowed, log],
  );
  useEffect(() => {
    const shells = runtime.tools.shells;
    shells.interactiveUser = true;
    preloadPty();
    shells.on('input', openTerminal);
    return () => {
      shells.off('input', openTerminal);
      takeoverEnd.current?.();
    };
  }, [openTerminal]);
  useInput((input, key) => {
    if (!(input === '\x1d' || (key.ctrl && input === ']'))) return;
    const s = runtime.tools.shells.running({background: false}).find((x) => x.tty);
    if (s) openTerminal(s);
  });

  // File changes and commands ask the user through an approval overlay. Several agents can ask at
  // once, so requests queue and are shown one at a time ("1 of 3").
  const approvals = useRef<{req: ApprovalRequest; resolve(d: ApprovalDecision): void}[]>([]);
  const approvalSeq = useRef(0);
  const showNextApproval = useCallback(() => {
    const next = approvals.current[0];
    if (!next) {
      setOverlay((o) => (o.name === 'approval' ? {name: 'none'} : o));
      runtime.remoteApproval = undefined;
      runtime.remoteBus.emit('approval');
      return;
    }
    let settled = false;
    const ide = runtime.ide;
    const change = ide && ['write', 'edit'].includes(next.req.tool.name) ? proposedChange(next.req, runtime.tools.pathsFor(next.req.tool.name, next.req.args)[0]) : undefined;
    const resolve = (d: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      if (change) void ide!.closeDiffs(); // answered in Rein: close the editor's diff tab
      approvals.current = approvals.current.filter((a) => a !== next);
      next.resolve(d);
      // "Allow all this session" also releases everything already waiting.
      if (d === 'session') {
        for (const a of approvals.current) a.resolve('session');
        approvals.current = [];
      }
      showNextApproval();
    };
    // The same change as a diff in the editor: Accept there allows it (with any edits made in the
    // diff), Reject or closing the tab denies it. Whichever side answers first wins.
    if (change) {
      void ide!.openDiff(change.path, change.contents, diffTabName(change.path)).then(
        (r) => {
          if (settled) return;
          if (r.answer === 'accepted' && r.contents !== undefined && r.contents !== change.contents) runtime.tools.useEditorVersion(change.path, r.contents);
          settled = true;
          approvals.current = approvals.current.filter((a) => a !== next);
          next.resolve(r.answer === 'accepted' ? 'once' : 'deny');
          showNextApproval();
        },
        () => {}, // the editor went away: answer in Rein
      );
    }
    setOverlay({
      name: 'approval',
      req: next.req,
      position: 1,
      total: approvals.current.length,
      resolve,
    });
    // The remote page can answer the same request (whichever side answers first wins).
    runtime.remoteApproval = {id: ++approvalSeq.current, req: next.req, resolve};
    runtime.remoteBus.emit('approval');
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

  // Multi-session dashboard (rein sessions): this session's status, and messages sent from there.
  const sendFromInbox = useRef<(text: string) => void>(() => {});
  sendFromInbox.current = (text) => {
    log('info', `From rein sessions: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
    if (chat.busy) setQueued((q) => [...q, text]);
    else void chat.send(text).then(bump);
  };
  useEffect(() => {
    const stop = watchInbox((text) => sendFromInbox.current(text));
    const bye = () => removeLive();
    process.on('exit', bye);
    return () => {
      stop();
      bye();
      process.off('exit', bye);
    };
  }, []);
  useEffect(() => {
    const t = runtime.engine?.transcript;
    const first = t?.messages.find((m) => m.role === 'user' && !m.synthetic)?.text ?? '';
    const ref = runtime.engine?.currentRef();
    const goal = runtime.goals.goal?.status === 'active' ? runtime.goals.goal.text : undefined;
    writeLive({
      cwd: process.cwd(),
      title: first.replace(/<skill[^>]*>[\s\S]*?<\/skill>\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(new conversation)',
      state: ['approval', 'ask', 'plan', 'trust'].includes(overlay.name) ? 'waiting' : chat.busy ? 'working' : 'idle',
      ...(goal ? {goal} : {}),
      ...(process.env.REIN_HOST ? {host: process.env.REIN_HOST} : {}),
      ...(ref ? {model: `${ref.provider}:${ref.model}`} : {}),
    });
  }, [chat.busy, overlay.name, statusTick]);

  const togglePlanMode = () => {
    runtime.planMode = !runtime.planMode;
    runtime.specMode = undefined;
    log('info', runtime.planMode ? 'Plan mode on — the agent explores read-only and presents a plan for your approval before changing anything. shift+tab to turn it off.' : 'Plan mode off.');
    bump();
  };
  // The agent asks questions: show them and wait for every answer.
  useEffect(() => {
    runtime.askPresenter = (questions) =>
      new Promise((resolve) => {
        setOverlay({
          name: 'ask',
          questions,
          resolve: (answers) => {
            setOverlay({name: 'none'});
            bump();
            resolve(answers);
          },
        });
      });
    return () => {
      runtime.askPresenter = undefined;
    };
  }, []);
  // The agent presents a plan: show it and wait for the user's decision.
  useEffect(() => {
    runtime.planPresenter = (plan) =>
      new Promise((resolve) => {
        setOverlay({
          name: 'plan',
          plan,
          resolve: (d) => {
            setOverlay({name: 'none'});
            log('info', {revise: 'Keep planning — type your feedback.', implement: 'Plan saved — implementing it now (plan mode off).', goal: '◎ Plan saved and started as a goal — milestones in the sidebar (plan mode off).', save: 'Plan saved to .rein/plans/ — start it any time with /goal:plan (plan mode off).'}[d]);
            bump();
            resolve(d);
          },
        });
      });
    return () => {
      runtime.planPresenter = undefined;
    };
  }, []);

  /** /rewind: your messages, newest first, with how many files Rein changed since each. */
  function openRewind() {
    const points: RewindPoint[] = runtime.engine.transcript.messages
      .map((m, index) => ({m, index}))
      .filter(({m}) => m.role === 'user' && !m.synthetic)
      .map(({m, index}) => ({index, at: m.at, text: displayText(m.text), files: runtime.checkpoints.changedSince(index).length, whole: runtime.snapshots.has(index)}))
      .reverse();
    setOverlay({name: 'rewind', points});
  }

  const doRewind = async (index: number, mode: RewindMode) => {
    setOverlay({name: 'none'});
    if (chat.busy) chat.interrupt();
    const t = runtime.engine.transcript;
    const text = t.messages[index]?.text ?? '';
    if (mode !== 'conversation') {
      // The whole-tree snapshot first (covers shell-made changes), then Rein's per-file checkpoints
      // for anything outside it (e.g. .gitignore'd files the agent edited).
      const changed = new Set<string>();
      let removedCount = 0;
      if (runtime.snapshots.has(index)) {
        try {
          const t = await runtime.snapshots.restore(index);
          t.restored.forEach((f) => changed.add(f));
          removedCount += t.removed.length;
          t.removed.forEach((f) => changed.add(f));
          for (const f of t.failed) log('error', `Couldn't restore the snapshot of ${f}`);
        } catch (err) {
          log('error', `Couldn't restore the project snapshot: ${(err as Error).message}`);
        }
      }
      const r = runtime.checkpoints.restore(index);
      for (const f of [...r.restored, ...r.removed]) changed.add(nodePath.relative(process.cwd(), f));
      removedCount += r.removed.filter((f) => !changed.has(nodePath.relative(process.cwd(), f))).length;
      const n = changed.size;
      log('info', `Rewound ${n} file${n === 1 ? '' : 's'}${removedCount ? ` (files created since were removed)` : ''}${r.skipped.length ? ` · ${r.skipped.length} too large to restore: ${r.skipped.join(', ')}` : ''}.`);
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
  // /ci watch hands its fix tasks over through these (set every render: they need the current chat).
  runtime.ciSubmit = (task) => (chat.busy ? setQueued((q) => [...q, task]) : void chat.send(task));
  runtime.uiLog = (text, kind) => log(kind ?? 'info', text);
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
    }
    if (!ready || !catalog.loaded || chat.busy || goalBusy.current || queued.length || overlay.name === 'approval' || g?.status !== 'active') return;
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
  // Notifications: when Rein needs you (approval, question, plan, hook trust), and when work that
  // took a while is finished (the goal loop and queued messages included, not each of its turns).
  useEffect(() => {
    const mode = runtime.config.notifications;
    if (overlay.name === 'approval') {
      notify(mode, 'Rein needs your approval', `${overlay.req.tool.label}(${overlay.req.summary})`);
      // Your phone, if nobody answers here within 30 s (you're probably away).
      const req = overlay.req;
      const t = setTimeout(() => {
        runtime.notifyRemote('Rein needs your approval', `${req.tool.label}(${req.summary}) in ${nodePath.basename(process.cwd())}`); // (answered sooner: the effect's cleanup cancels this)
      }, 30_000);
      return () => clearTimeout(t);
    }
    else if (overlay.name === 'ask') notify(mode, 'Rein has a question', overlay.questions[0]?.question ?? 'The agent is waiting for your answer');
    else if (overlay.name === 'plan') notify(mode, 'Rein has a plan for you', overlay.plan.title);
    else if (overlay.name === 'trust') notify(mode, 'Rein', "This project's hooks need your review");
  }, [overlay.name]);
  // idle-compact: a conversation left idle is compacted a little before its prompt cache expires,
  // from the warm cache (Engine.idleCompactAt). A message sent meanwhile waits in the queue.
  useEffect(() => {
    if (!ready || chat.busy || compacting) return;
    const at = runtime.engine?.idleCompactAt();
    if (at === undefined) return;
    const t = setTimeout(() => {
      if (chatRef.current.busy) return;
      setCompacting({startedAt: Date.now(), label: 'Compacting while idle', idle: true});
      void runtime.engine
        .idleCompact()
        .then(
          (res) => {
            if (res && !('skipped' in res)) add({kind: 'compact', reason: 'idle', result: res});
          },
          (err) => log('error', `Compaction while idle failed: ${(err as Error).message}`),
        )
        .finally(() => {
          setCompacting(undefined);
          bump();
        });
    }, Math.max(0, at - Date.now()));
    t.unref?.();
    return () => clearTimeout(t);
  }, [ready, chat.busy, compacting, statusTick]);

  // The pet reacts to the agent: working, waiting on you, then done (or failed) when the turn ends.
  const petBusy = useRef(false);
  useEffect(() => {
    if (['approval', 'ask', 'plan', 'trust'].includes(overlay.name)) runtime.pets.setActivity('waiting');
    else if (chat.busy) runtime.pets.setActivity('working');
    else if (petBusy.current) {
      extensions.emit('turnEnd');
      runtime.pets.setActivity(entries.at(-1)?.kind === 'error' ? 'failed' : 'done');
      // A pet the create-pet skill just finished: Rein's own now, and on screen.
      const fresh = runtime.pets.pickUp();
      if (fresh.length) {
        void runtime.pets.refresh().then(() => runtime.pets.setActivity('hello'), () => {});
        log('info', `${fresh.map((x) => x.name).join(', ')} ${fresh.length > 1 ? 'are' : 'is'} one of your pets now (/pet), and here in the sidebar.`);
      }
    }
    petBusy.current = chat.busy;
  }, [chat.busy, overlay.name]);

  const working = chat.busy || !!goalNote || queued.length > 0 || !!compacting;
  const workStarted = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (working) {
      workStarted.current ??= Date.now();
      return;
    }
    const started = workStarted.current;
    if (started === undefined) return;
    // Idle for a moment (the goal loop starts its next step right after a turn ends).
    const t = setTimeout(() => {
      workStarted.current = undefined;
      if (Date.now() - started < NOTIFY_AFTER_MS) return;
      const g = runtime.goals.goal;
      const what = g?.status === 'done' ? `Goal achieved: ${g.text}` : g?.status === 'paused' ? `Goal paused: ${g.text}` : 'Ready for your next message';
      notify(runtime.config.notifications, 'Rein is done', what);
      runtime.notifyRemote('Rein is done', `${what} (${nodePath.basename(process.cwd())})`);
    }, 1500);
    return () => clearTimeout(t);
  }, [working]);

  // Background commands run until stopped (no timeout). When a turn ends, mention any that have been
  // going for a while, once each, so a forgotten dev server or emulator doesn't run unnoticed.
  const announcedBg = useRef(new Set<number>());
  useEffect(() => {
    if (chat.busy) return;
    const stale = runtime.tools.shells
      .running({background: true})
      .filter((s) => Date.now() - s.startedAt >= BACKGROUND_REMINDER_MS && !announcedBg.current.has(s.id));
    if (!stale.length) return;
    stale.forEach((s) => announcedBg.current.add(s.id));
    log('info', `Still running in the background: ${stale.map((s) => `#${s.id} ${s.command.slice(0, 60)} (${shellStatusText(s).replace('running ', '')})`).join(', ')}. Ask the agent to stop ${stale.length > 1 ? 'them' : 'it'} if you're done, or /shells to look.`);
  }, [chat.busy]);

  // ...and after an hour (backgroundCheckMinutes), a fork of the agent checks whether each is still
  // needed and stops the ones that aren't. Unsure keeps them running.
  const bgChecked = useRef(new Map<number, number>());
  const bgChecking = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => {
      if (bgChecking.current) return;
      const due = dueForCheck(runtime.tools.shells.list(), bgChecked.current, runtime.config.backgroundCheckMinutes);
      const shell = due[0];
      if (!shell) return;
      bgChecking.current = true;
      bgChecked.current.set(shell.id, Date.now());
      const age = shellStatusText(shell).replace('running ', '');
      void stillNeeded(runtime.engine, runtime.config, runtime.tools.shells, shell)
        .then((v) => {
          if (shell.status !== 'running') return;
          if (v.keep) log('info', `Background #${shell.id} ${shell.command.slice(0, 60)} has run ${age}; the agent says it's still needed (${v.reason}). Checking again later.`);
          else {
            runtime.tools.shells.kill(shell.id);
            log('info', `Stopped background #${shell.id} ${shell.command.slice(0, 60)} after ${age}: the agent no longer needs it (${v.reason}).`);
          }
        })
        .catch(() => {}) // couldn't ask: leave it running, try again next round
        .finally(() => (bgChecking.current = false));
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (chat.busy || compacting?.idle || !queued.length) return;
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
  }, [chat.busy, queued, compacting]);

  const prevDraft = useRef('');
  // Pastes, images and dropped files shown as placeholders in the input; expanded on send.
  const attachments = useRef(new Attachments(() => nodePath.join(runtime.engine.scratch, 'images'), () => runtime.config.collapsePastes !== false));
  const onPaste = (text: string) => attachments.current.paste(text);
  // Ctrl+R: reverse search through this project's sent messages.
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'r') setOverlay({name: 'history', entries: loadHistory(process.cwd())});
    },
    {isActive: inputActive},
  );
  const pickHistory = (text: string | undefined) => {
    setOverlay({name: 'none'});
    if (text === undefined) return;
    prevDraft.current = text;
    setDraft(text);
  };
  // The editor's "mention in chat" (Claude Code extension) inserts `@file` into the input.
  useEffect(() => {
    runtime.onIdeChange = bump;
    runtime.onIdeMention = (m) => {
      const rel = nodePath.relative(process.cwd(), m.filePath) || m.filePath;
      const lines = m.lineStart ? ` (lines ${m.lineStart}${m.lineEnd && m.lineEnd !== m.lineStart ? `-${m.lineEnd}` : ''})` : '';
      setDraft((d) => {
        const next = `${d}${d && !d.endsWith(' ') ? ' ' : ''}@${rel}${lines} `;
        prevDraft.current = next;
        return next;
      });
    };
    return () => {
      runtime.onIdeChange = undefined;
      runtime.onIdeMention = undefined;
    };
  }, []);
  // ↑/↓ recall of earlier messages (per project, kept across sessions); off while a list uses the arrows.
  const history = useRef(new HistoryCursor(loadHistory(process.cwd())));
  const onExternalEdit = (current: string) => {
    const edited = editExternally(current, opts.renderer === 'fullscreen');
    if (edited === undefined) log('error', 'The editor exited with an error, so the draft is unchanged. Rein uses $VISUAL or $EDITOR (else vi).');
    else prevDraft.current = edited;
    return edited;
  };
  const onHistory = (dir: -1 | 1, current: string) => {
    const recalled = history.current.move(dir, current);
    if (recalled !== undefined) prevDraft.current = recalled;
    return recalled;
  };
  // Voice input (voice/voice.ts): hold Ctrl+Space to talk, let go to stop (terminal/voiceKey.ts);
  // a tap, or /voice, toggles. The text lands in the input (never sent on its own).
  const [voice, setVoice] = useState<VoiceState>('idle');
  const recording = useRef<{rec: Recording; timer: NodeJS.Timeout} | undefined>(undefined);
  const ptt = useRef(new PushToTalk());
  const insertVoice = (text: string) => setDraft((d) => (d && !/\s$/.test(d) ? `${d} ${text}` : d + text));
  const stopVoice = async () => {
    ptt.current.reset();
    const r = recording.current;
    if (!r) return;
    recording.current = undefined;
    clearTimeout(r.timer);
    setVoice('transcribing');
    try {
      const s = detect(runtime.config.voiceModel || DEFAULT_MODEL);
      const wav = await r.rec.stop();
      const text = await transcribe(s.whisper!, s.model, wav).finally(() => rmSync(wav, {force: true}));
      if (text) insertVoice(text);
      else log('info', 'No speech was recognized.');
    } catch (err) {
      log('error', `Voice: ${(err as Error).message}`);
    } finally {
      setVoice('idle');
    }
  };
  const startVoice = (held: boolean) => {
    if (recording.current || voice === 'transcribing') return;
    const s = detect(runtime.config.voiceModel || DEFAULT_MODEL);
    const hint = installHint(s);
    if (hint || !s.modelReady) {
      ptt.current.reset();
      log('info', `${hint ? hint.text : `Voice needs its speech model (${s.model}, about 60 MB, downloaded once).`} Run /voice setup${hint?.command ? ' to install it' : ''}.`);
      return;
    }
    recording.current = {rec: new Recording(s.recorder!), timer: setTimeout(() => void stopVoice(), MAX_RECORD_SECONDS * 1000)};
    setVoice(held ? 'holding' : 'recording');
  };
  const cancelVoice = () => {
    ptt.current.reset();
    const r = recording.current;
    if (!r) return false;
    recording.current = undefined;
    clearTimeout(r.timer);
    r.rec.cancel();
    setVoice('idle');
    return true;
  };
  // Ctrl+Space comes from the stdin filter; only while the input box has the keyboard.
  const inputActiveRef = useRef(true);
  inputActiveRef.current = inputActive;
  useEffect(() => {
    const p = ptt.current;
    const onKey = (ev: VoiceKeyEvent) => (inputActiveRef.current || p.recording) && p.key(ev);
    const onStart = () => startVoice(true);
    const onToggled = () => recording.current && setVoice('recording');
    const onStop = () => void stopVoice();
    voiceKeys.on('key', onKey);
    p.on('start', onStart);
    p.on('toggled', onToggled);
    p.on('stop', onStop);
    return () => {
      voiceKeys.off('key', onKey);
      p.off('start', onStart);
      p.off('toggled', onToggled);
      p.off('stop', onStop);
    };
  });

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
  // Shift+Tab toggles plan mode (like Claude Code), when no suggestion list is using Tab.
  useInput(
    (_input, key) => {
      if (key.tab && key.shift) togglePlanMode();
    },
    {isActive: inputActive && !suggestions.length && !fileSuggestions.length},
  );

  /**
   * `!command`: run it yourself in the project (no approval: you typed it), with live output, like
   * Claude Code's bash mode. The command and its output go along with your next message.
   */
  const runBang = (command: string) => {
    logMain('user', `! ${command}`);
    const cap = runtime.config.shellMaxMinutes;
    const {shell, done} = runtime.tools.shells.start(command, {cwd: process.cwd(), background: false, timeoutMs: cap ? cap * 60_000 : 24 * 3600_000, maxMs: cap ? cap * 60_000 : undefined});
    void done.then((s) => {
      const status = s.status === 'exited' ? `exit ${s.exitCode ?? '?'}` : s.status;
      const output = runtime.tools.shells.tail(s, 2000);
      runtime.noteUserShell(command, status, output);
      const shown = runtime.tools.shells.tail(s, 30);
      logMain(s.status === 'exited' && s.exitCode === 0 ? 'info' : 'error', `${shown || '(no output)'}\n[${shellStatusText(s)}] · goes along with your next message`);
      void shell;
    });
  };

  // The remote page (remote/server.ts): what it shows, what it can do. Messages from it go
  // through runCommand like typed ones; a few commands only make sense at the keyboard.
  const REMOTE_REFUSED = new Set(['exit', 'vault', 'remote', 'login', 'settings', 'update', 'tui', 'ide', 'voice']);
  const remoteLive = useRef('');
  const remoteState = (): RemoteState => {
    const t = runtime.engine?.transcript;
    const ref = runtime.config.chatModel && runtime.config.chatModel !== 'auto' ? parseRef(runtime.config.chatModel) : undefined;
    const a = runtime.remoteApproval;
    return {
      project: nodePath.basename(process.cwd()),
      model: ref ? (catalog.get(ref)?.label ?? ref.model) : 'auto',
      busy: chatRef.current.busy,
      waitingUntil: (chatRef.current as {waitUntil?: number}).waitUntil, // (with waitForLimits)
      messages: (t?.messages ?? []).slice(-60).map((m) => ({role: m.role, text: m.text.slice(0, 8000), tools: m.tools?.map((x) => ({label: x.label, summary: x.summary, ok: x.ok}))})),
      live: remoteLive.current || undefined,
      approval: a && {
        id: a.id,
        title: `Rein wants to ${a.req.tool.label}`,
        summary: a.req.summary,
        preview: a.req.preview.slice(0, 6000),
        options: [{decision: 'once', label: 'Allow'}, ...(a.req.sensitive || a.req.planMode ? [] : [{decision: 'session', label: (a.req as {sessionLabel?: string}).sessionLabel ?? 'Allow all this session'}]), {decision: 'deny', label: 'Deny'}],
      },
    };
  };
  useEffect(() => {
    const bus = runtime.remoteBus;
    const onEngine = (ev: EngineEvent) => {
      const s = runtime.remote;
      if (ev.type === 'text') {
        remoteLive.current += ev.delta;
        s?.push('delta', {text: ev.delta});
        return;
      }
      if (ev.type === 'done' || ev.type === 'error') remoteLive.current = '';
      if (ev.type === 'tokens') return;
      s?.push('state');
    };
    const onApproval = () => runtime.remote?.push('state');
    const onInput = (text: string) => {
      const name = /^\/([\w:-]+)/.exec(text.trim())?.[1];
      if (name && REMOTE_REFUSED.has(name)) return logMain('error', `/${name} can't be run from the remote page.`);
      logMain('info', '⇢ from the remote page');
      runCommandRef.current(text);
    };
    bus.on('engine', onEngine);
    bus.on('approval', onApproval);
    bus.on('input', onInput);
    return () => {
      bus.off('engine', onEngine);
      bus.off('approval', onApproval);
      bus.off('input', onInput);
    };
  }, []);
  const remoteCommand = async (args: string) => {
    const [sub = 'on'] = args.split(/\s+/);
    const cfg = runtime.config;
    if (sub === 'off') {
      await runtime.remote?.stop();
      runtime.remote = undefined;
      return logMain('info', 'Remote page stopped.');
    }
    if (sub === 'unpair') {
      runtime.remote?.unpairAll();
      return logMain('info', 'Every paired device is forgotten: pair again with /remote pair.');
    }
    if (sub === 'status') {
      const s = runtime.remote;
      return logMain('info', s?.running ? `Remote page on http://${s.address!.host}:${s.address!.port} · ${s.paired} paired device${s.paired === 1 ? '' : 's'}` : 'The remote page is off. /remote on starts it.');
    }
    if (sub !== 'on' && sub !== 'pair') return logMain('error', 'Usage: /remote [on] · /remote pair · /remote status · /remote unpair · /remote off');
    if (!runtime.remote?.running) {
      const server = new RemoteServer({
        state: remoteState,
        send: (text) => runtime.remoteBus.emit('input', text),
        approve: (id, decision) => {
          const a = runtime.remoteApproval;
          if (!a || a.id !== id || !['once', 'session', 'deny'].includes(decision)) return false;
          if (decision === 'session' && (a.req.sensitive || a.req.planMode)) return false;
          a.resolve(decision as ApprovalDecision);
          return true;
        },
        interrupt: () => chatRef.current.interrupt(),
      });
      const host = cfg.remoteHost || '127.0.0.1';
      try {
        await server.start(cfg.remotePort ?? 7377, host);
      } catch (err) {
        return logMain('error', `Couldn't start the remote page: ${(err as Error).message}`);
      }
      runtime.remote = server;
    }
    const s = runtime.remote!;
    const code = s.newCode();
    const {host, port} = s.address!;
    const local = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    logMain(
      'info',
      [
        `Remote page: http://${local ? 'localhost' : host}:${port} · pairing code ${code} (5 minutes, one device)`,
        local
          ? `It listens on this computer only. From your phone, open it through Tailscale (tailscale serve ${port}) or a Cloudflare tunnel (cloudflared tunnel --url http://localhost:${port}).`
          : `⚠ It listens on ${host}: anyone who can reach that address can try to pair. Prefer a tunnel with HTTPS.`,
        'Anyone paired can send the agent messages and answer its approvals. /remote unpair forgets every device; /remote off stops it.',
      ].join('\n'),
    );
  };

  const runCommandRef = useRef<(raw: string) => void>(() => {});
  const runCommand = (raw: string) =>
    runCommandWith(raw, {
      windowed, viewing, logMain, add, setEntries, banner, bump, chat, setOverlay, setQueued, setView, attachments, skills, setSkills,
      opts, updating, setUpdating, setUpdateLog, compacting, setCompacting, exit, refresh, runBang, remoteCommand, openShells, openRewind, openResume,
      startVoice, stopVoice, recording,
    });

  runRef.current = runCommand;

  const onSubmit = (typed: string) => {
    // Enter while picking an @file accepts it (unless it's already typed out in full).
    if (fileSelected && mention && mention.query !== fileSelected) {
      acceptFile(fileSelected);
      return;
    }
    // Enter while the command list is showing fills in the highlighted one ("/name ") so arguments
    // can follow; the list closes at the space, so Enter again runs it. A command typed out in full
    // (and not changed with the arrows) runs right away.
    const partial = suggestCommands(typed, skills);
    const typedExact = suggestIndex === 0 && partial[0] && `/${partial[0].name}` === typed.trim().toLowerCase();
    if (partial.length && !typedExact) {
      const pick = partial[Math.min(suggestIndex, partial.length - 1)] ?? partial[0]!;
      const filled = `/${pick.name} `;
      prevDraft.current = filled;
      setDraft(filled);
      setSuggestIndex(0);
      return;
    }
    prevDraft.current = '';
    setDraft('');
    setSuggestIndex(0);
    // `/vault set NAME <value>` would leak the value: never keep it (the command refuses it too).
    if (!/^\s*\/vault\s+set\s+\S+\s+\S/.test(typed)) addHistory(process.cwd(), typed);
    history.current.reset(loadHistory(process.cwd()));
    if (catalog.loaded || !catalogReady.current) runCommand(typed);
    else void catalogReady.current.then(() => runCommand(typed));
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
    const bg = runtime.tools.shells.list().filter((s) => s.background && (viewing ? s.origin?.agentId === viewing.id : !s.origin));
    const running = bg.filter((s) => s.status === 'running');
    if (running.length === 1) setOverlay({name: 'shell', id: running[0]!.id});
    else if (!running.length && bg.length === 1) setOverlay({name: 'shell', id: bg[0]!.id});
    else setOverlay({name: 'shells'});
  };

  // The /context window refreshes live while open (the agent keeps working underneath).
  const contextOpen = overlay.name === 'context';
  useEffect(() => {
    if (!contextOpen) return;
    const timer = setInterval(() => {
      const a = viewing;
      const report = a
        ? subagentContextReport(a, runtime.config, runtime.tools.specs({subagent: true, includeMainOnly: a.mode === 'fork'}))
        : contextReport(runtime.engine, runtime.config, runtime.tools.specs({includeMainOnly: true}));
      void report.then(
        (r) => setOverlay((o) => (o.name === 'context' ? {...o, report: r} : o)),
        () => {},
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [contextOpen, viewing]);

  /** /goal:plan → a saved plan: make it the goal and start working on it. */
  const startPlanGoal = (p: SavedPlan) => {
    setOverlay({name: 'none'});
    if (viewing) setView('main');
    const goal = runtime.goals.set(`Carry out the plan "${p.title}"`, p.file);
    logMain('info', `◎ Goal: carry out the plan "${p.title}" — ${p.milestones.filter((m) => m.done).length}/${p.milestones.length} milestones done. Progress shows in the sidebar; /goal pause · resume · clear`);
    const kick = runtime.goals.kickoff(goal);
    if (chat.busy) setQueued((q) => [...q, kick]);
    else void chat.send(kick).then(bump);
  };
  /** /goal:plan → "start a new plan": put /plan in the input for the task description. */
  const startNewPlan = () => {
    setOverlay({name: 'none'});
    prevDraft.current = '/plan ';
    setDraft('/plan ');
  };

  const saveVault = (secret: string, value: string) => {
    setOverlay({name: 'none'});
    void runtime.vault.set(secret, value).then(
      (where) => logMain('info', `Saved ${secret} in the vault (${where === 'keychain' ? (process.platform === 'darwin' ? 'macOS Keychain' : 'encrypted with DPAPI') : 'secrets/vault.json, 0600'}). The agent's shell commands get it as $${secret}.`),
      (err) => logMain('error', `Couldn't save ${secret}: ${(err as Error).message}`),
    );
  };

  const closeOverlay = () => {
    setOverlay({name: 'none'});
    void refresh();
  };

  runCommandRef.current = runCommand;
  return {
    entries, transcript: terminalHold.current === undefined ? entries : entries.slice(0, terminalHold.current), add, log, overlay, setOverlay, closeOverlay, finishImport, ready, updating, updateLog, statusTick, bump,
    finishTrust, pickHistory, startPlanGoal, startNewPlan, draft, onDraft, onSubmit, onPaste, onImagePaste, onHistory: suggestions.length || fileSuggestions.length ? undefined : onHistory, onExternalEdit, doRewind, togglePlanMode, fileSuggestions, fileSelected, acceptFile, runCommand, suggestions, selected, setSuggestIndex, inputActive, chat, skills, openShells, queued, exitArmed, compacting, pickSession,
    view, setView, viewing, goalNote, saveVault, voice,
  };
}

/** Show the last few turns of a resumed conversation. */
/** A stored user message as the user typed it (skill prompts back to `/name args`). */
export const displayText = (text: string) => text.replace(/^<skill name="([^"]+)"[\s\S]*?<\/skill>\s*/, '/$1 ');

function replay(t: Transcript, add: AddEntry): void {
  const recent = t.messages.slice(-10);
  add({kind: 'info', text: t.messages.length > recent.length ? `Resumed conversation (${t.messages.length} messages; showing the last ${recent.length})` : 'Resumed conversation'});
  for (const m of recent) {
    if (m.synthetic) add({kind: 'info', text: 'Context compacted mid-task — the agent carried on from the summary.'});
    else if (m.role === 'user') add({kind: 'user', text: displayText(m.text), ...(m.images?.length ? {images: m.images.map((i) => i.path)} : {})});
    else {
      for (const tool of m.tools ?? []) {
        const plan = planPreview(tool.label, tool.summary, tool.ok, tool.result);
        add({kind: 'tool', ...tool, ...(plan ? {plan} : {})});
      }
      add({kind: 'assistant', text: m.text, first: true});
      if (m.cutOff) add({kind: 'info', text: `Rein stopped in the middle of this turn; its work so far was saved (${m.tools?.length ?? 0} tool call${m.tools?.length === 1 ? '' : 's'}). Say "continue" and the agent picks up from there.`});
    }
  }
}

