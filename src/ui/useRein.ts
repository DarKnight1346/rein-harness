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
import {subagentContextReport, contextReport, type ContextReport} from '../session/context.js';
import {compactableCount} from '../session/compactor.js';
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
import {DEFAULT_MODEL, detect, downloadModel, installHint, MAX_RECORD_SECONDS, Recording, transcribe, voiceDir} from '../voice/voice.js';
import {NAME_RE} from '../vault/vault.js';
import {installable, installedVersion, resolveServer, SERVERS} from '../lsp/servers.js';
import {loadPlugins} from '../plugins/index.js';
import {conversationMarkdown, writeExport} from '../session/export.js';
import {copyToClipboard} from './terminal/clipboard.js';
import {editExternally} from './terminal/editor.js';
import {addHistory, HistoryCursor, loadHistory} from '../store/history.js';
import {askBtwSubagent, btw} from '../session/btw.js';
import type {Transcript} from '../session/transcript.js';
import type {AddEntry, Entry} from './entries.js';
import type {ApprovalDecision, ApprovalRequest} from '../tools/host.js';
import {dueForCheck, stillNeeded} from '../tools/backgroundCheck.js';
import {shellStatusText, type Shell} from '../tools/shells.js';
import {subagentStatusText} from '../agents/manager.js';
import {report as agentReport} from '../agents/tools.js';
import {describeChatModel, resolveModelQuery} from './ModelScreen.js';
import {useChat} from './useChat.js';
import {Attachments} from './attachments.js';
import {mentionAt, primeFiles, suggestFiles} from './mentions.js';
import type {RewindMode, RewindPoint} from './RewindScreen.js';
import type {PlanDecision, PresentedPlan} from '../tools/plan.js';
import {listPlans, type SavedPlan} from '../plans/store.js';
import {planPreview} from './planPreview.js';
import type {AskAnswer, AskQuestion} from '../tools/ask.js';
import {settingsFiles} from '../tools/permissions.js';
import {memoryFacts, memoryFile} from '../tools/memory.js';
import {readFileSync} from 'node:fs';
import {accountName, hidingIdentity, redact} from './privacy.js';
import nodePath from 'node:path';

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
  | {name: 'settings'}
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
  const logMain = log;

  const chat = useChat(add, log, {split: opts.renderer === 'classic'});

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
      // A codex whose app-server protocol changed under Rein is switched off (see compat.ts).
      const compat = catalog.codexCompat;
      if (compat?.ok === false) log('error', incompatibleMessage(compat));
      else for (const w of compat?.warnings ?? []) log('info', `Codex ${compat!.version}: ${w}`);
      const shadowed = shadowedSkills(loadSkills());
      if (shadowed.length) log('info', `Skill${shadowed.length > 1 ? 's' : ''} ${shadowed.map((s) => `"${s.name}"`).join(', ')} hidden by built-in command${shadowed.length > 1 ? 's' : ''}; rename to use ${shadowed.length > 1 ? 'them' : 'it'}.`);
      setReady(true);
      // Project MCP servers wait for approval (a repo shouldn't launch commands on its own).
      setTimeout(() => {
        const waiting = runtime.mcp.list().filter((s) => s.status === 'needs-approval').map((s) => s.name);
        if (waiting.length) log('info', `This project's .mcp.json has MCP server${waiting.length > 1 ? 's' : ''} waiting for your approval: ${waiting.join(', ')} — /mcp to review.`);
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
  const showNextApproval = useCallback(() => {
    const next = approvals.current[0];
    if (!next) {
      setOverlay((o) => (o.name === 'approval' ? {name: 'none'} : o));
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

  const togglePlanMode = () => {
    runtime.planMode = !runtime.planMode;
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
  // Notifications: when Rein needs you (approval, question, plan, hook trust), and when work that
  // took a while is finished (the goal loop and queued messages included, not each of its turns).
  useEffect(() => {
    const mode = runtime.config.notifications;
    if (overlay.name === 'approval') notify(mode, 'Rein needs your approval', `${overlay.req.tool.label}(${overlay.req.summary})`);
    else if (overlay.name === 'ask') notify(mode, 'Rein has a question', overlay.questions[0]?.question ?? 'The agent is waiting for your answer');
    else if (overlay.name === 'plan') notify(mode, 'Rein has a plan for you', overlay.plan.title);
    else if (overlay.name === 'trust') notify(mode, 'Rein', "This project's hooks need your review");
  }, [overlay.name]);
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
      notify(runtime.config.notifications, 'Rein is done', g?.status === 'done' ? `Goal achieved: ${g.text}` : g?.status === 'paused' ? `Goal paused: ${g.text}` : 'Ready for your next message');
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

  const runCommand = (raw: string) => {
    // `!command` runs a shell command directly (main conversation only).
    if (/^\s*!\s*\S/.test(raw) && !viewing) {
      runBang(raw.trim().slice(1).trim());
      return;
    }
    // Viewing a subagent: command feedback shows in its view (the main history isn't on screen).
    const shown = viewing;
    const log = shown ? (kind: 'info' | 'error' | 'user', text: string) => kind !== 'user' && runtime.agents.note(shown.id, kind === 'error' ? `✗ ${text}` : text) : logMain;
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
      if (parsed.skill.planMode && !runtime.planMode) {
        runtime.planMode = true;
        log('info', 'Plan mode on — nothing changes until you approve the plan (shift+tab turns it off).');
      }
      if (viewing) {
        // Viewing a subagent: the skill runs there, like a message would.
        if (args.images.length) log('info', 'Images can only be sent to the main agent; the subagent gets the text.');
        void runtime.agents.message(viewing.id, skillPrompt(parsed.skill, args.text)).catch((err) => log('error', (err as Error).message));
        return;
      }
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
    // Commands about the main conversation itself: say so instead of silently acting on main while
    // a subagent is on screen.
    const MAIN_ONLY: Record<string, string> = {
      compact: 'Subagents can\'t be compacted — /compact works on the main conversation',
      rewind: 'Rewind works on the main conversation (subagents keep no checkpoints)',
      clear: '/clear clears the main conversation and stops every subagent',
      resume: '/resume replaces the main conversation',
    };
    if (viewing && MAIN_ONLY[parsed.name]) {
      log('info', `${MAIN_ONLY[parsed.name]}. Switch back first: /agent main, or click ◂ main at the top.`);
      return;
    }
    if (chat.busy && ['clear', 'compact', 'tui', 'update', 'resume'].includes(parsed.name)) {
      log('info', `/${parsed.name} waits until the agent is idle (esc interrupts it).`);
      return;
    }
    // In fullscreen, commands that open a window don't echo into the history.
    const opensWindow = ['goal:plan', 'login', 'usage', 'context', 'help', 'update', 'settings', 'shells', 'btw', 'resume', 'agents', 'agent'].includes(parsed.name) || (parsed.name === 'model' && !parsed.args);
    // A value typed after `/vault set NAME` stays off the screen and out of the transcript.
    if (!(windowed && opensWindow)) log('user', parsed.name === 'vault' ? raw.trim().replace(/^(\/vault\s+set\s+\S+)\s+.*$/s, '$1 ••••') : raw.trim());
    switch (parsed.name) {
      case 'mcp':
        setOverlay({name: 'mcp'});
        break;
      case 'voice': {
        const s = detect(runtime.config.voiceModel || DEFAULT_MODEL);
        const hint = installHint(s);
        if (parsed.args.trim() === 'setup') {
          if (hint?.command) {
            log('info', `Installing with Homebrew: ${hint.command}`);
            runBang(hint.command);
            log('info', 'When it finishes, run /voice setup again for the speech model.');
            return;
          }
          if (hint) return log('info', hint.text);
          if (s.modelReady) return log('info', 'Voice is ready: hold Ctrl+Space and talk, let go to stop.');
          log('info', `Downloading the speech model ${s.model} (about 60 MB, once) to ${voiceDir()}…`);
          let shown = 0;
          void downloadModel(s.model, (done, total) => {
            const pct = total ? Math.floor((done / total) * 100) : 0;
            if (pct >= shown + 25) log('info', `  ${(shown = pct)}%`);
          }).then(
            () => log('info', 'Voice is ready: hold Ctrl+Space and talk, let go to stop. (macOS asks once to let your terminal use the microphone.)'),
            (err) => log('error', `Couldn't download the speech model: ${(err as Error).message}`),
          );
          return;
        }
        if (parsed.args.trim()) return log('error', 'Usage: /voice · /voice setup');
        if (hint || !s.modelReady) {
          log('info', [`Voice input runs on your machine (whisper.cpp; nothing is uploaded).`, `Recorder: ${s.recorder ? s.recorder.command : 'missing'} · whisper.cpp: ${s.whisper ?? 'missing'} · model ${s.model}: ${s.modelReady ? 'ready' : 'not downloaded'}`, hint ? hint.text : '', `Run /voice setup${hint?.command ? ` (runs ${hint.command}, then downloads the model)` : hint ? ' after installing them' : ' to download the model'}.`].filter(Boolean).join('\n'));
          return;
        }
        // Ready: /voice toggles recording (like a tap of Ctrl+Space).
        if (recording.current) void stopVoice();
        else startVoice(false);
        return;
      }
      case 'vault': {
        const [sub = '', name = '', ...rest] = parsed.args.trim().split(/\s+/);
        if (sub === 'set' || sub === 'add') {
          if (rest.length) return log('error', `Don't type the value in the command: run /vault set ${name || 'NAME'} and enter it in the hidden field. It was not saved.`);
          if (!NAME_RE.test(name)) return log('error', 'Usage: /vault set NAME (letters, digits and _, like GITHUB_TOKEN)');
          setOverlay({name: 'vault', secret: name});
          return;
        }
        if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
          if (!name) return log('error', 'Usage: /vault rm NAME');
          void runtime.vault.remove(name).then((ok) => log(ok ? 'info' : 'error', ok ? `Removed ${name} from the vault.` : `${name} isn't in the vault.`), (err) => log('error', `Couldn't update the vault: ${(err as Error).message}`));
          return;
        }
        if (sub) return log('error', 'Usage: /vault · /vault set NAME · /vault rm NAME');
        const names = runtime.vault.names();
        log(
          'info',
          names.length
            ? `Secrets vault (${process.platform === 'darwin' && !process.env.REIN_HOME ? 'macOS Keychain' : process.platform === 'win32' && !process.env.REIN_HOME ? 'encrypted with Windows DPAPI' : 'secrets/vault.json, 0600'}): ${names.map((n) => `$${n}`).join(', ')}\nThe agent's shell commands get them as environment variables; their values are masked as [secret:NAME] in anything the agent sees. /vault set NAME · /vault rm NAME`
            : 'The secrets vault is empty. /vault set NAME stores a secret (an API token, a password) that the agent can use in shell commands as $NAME without ever seeing it.',
        );
        return;
      }
      case 'lsp': {
        if (parsed.args.trim() === 'stop') {
          void runtime.lsp.closeAll().then(() => log('info', 'Stopped the language servers (they start again when needed).'));
          return;
        }
        const running = runtime.lsp.status();
        const lines = running.length
          ? running.map((s) => `${s.server.padEnd(11)} ${s.rssMB !== undefined ? `${s.rssMB} MB`.padStart(7) : ''}  ${s.files} file${s.files === 1 ? '' : 's'} open · idle ${s.idleMin} min · ${s.root}`)
          : ['No language servers running (they start when you work on a matching file).'];
        const available: string[] = [];
        const canInstall: string[] = [];
        const manualOnly: string[] = [];
        for (const sp of SERVERS) {
          const r = resolveServer(sp, runtime.config.lspServers ?? {});
          if (r) available.push(`  ${sp.name}: ${r.where === 'rein' ? `installed by Rein${installedVersion(sp) ? ` (${installedVersion(sp)})` : ''}` : r.where === 'config' ? `configured (${r.command})` : `${r.command}`}`);
          else (installable(sp).ok ? canInstall : manualOnly).push(sp.id);
        }
        const installed = [
          available.length ? 'Available:' : 'No language servers installed yet.',
          ...available,
          canInstall.length ? `Rein can install (the agent offers when you work on one): ${canInstall.join(', ')}` : '',
          manualOnly.length ? `Install yourself (comes with the toolchain; the agent says how): ${manualOnly.join(', ')}` : '',
        ].filter(Boolean);
        log('info', [...lines, '', ...installed, (runtime.config.lsp ?? 'auto') === 'off' ? '\nBuilt-in language servers are off (config lsp).' : `Idle servers stop after ${runtime.config.lspIdleMinutes ?? 10} min. /lsp stop stops them now.`].join('\n'));
        return;
      }
      case 'plugins': {
        const plugins = loadPlugins();
        const codexSkills = skills.filter((s) => s.source === 'codex').map((s) => `/${s.name}`);
        if (!plugins.length && !codexSkills.length) {
          log('info', 'No plugins installed. Install them with `claude plugin install …` or Codex; Rein loads them on the next /plugins or start.');
          return;
        }
        const count = (n: number, what: string) => (n ? `${n} ${what}${n === 1 ? '' : 's'}` : '');
        const lines = plugins.map((p) => {
          const own = skills.filter((s) => s.plugin === p.name).map((s) => `/${s.name}`);
          const parts = [count(own.length, 'command'), count(p.agents.length, 'agent'), count(Object.keys(p.hooks ?? {}).length, 'hook event'), count(Object.keys(p.mcpServers ?? {}).length, 'MCP server')].filter(Boolean);
          return `${p.name} ${p.version ?? ''} · ${p.from === 'claude' ? 'Claude Code' : 'Codex'}${parts.length ? ` · ${parts.join(', ')}` : ''}${own.length ? `\n  ${own.join('  ')}` : ''}`;
        });
        log('info', [...lines, ...(codexSkills.length ? [`Codex skills: ${codexSkills.join('  ')}`] : [])].join('\n'));
        return;
      }
      case 'export': {
        const t = viewing ? undefined : runtime.engine.transcript;
        if (!t?.messages.length) {
          log('info', viewing ? '/export works on the main conversation.' : 'Nothing to export yet.');
          return;
        }
        const md = conversationMarkdown(t, {redact});
        try {
          const file = writeExport(t, md, parsed.args.trim() || undefined);
          void copyToClipboard(md).then((ok) => log('info', `Exported ${t.messages.length} messages to ${redact(file)}${ok ? ' and copied it to the clipboard' : ''}.`));
        } catch (err) {
          log('error', `Couldn't export: ${(err as Error).message}`);
        }
        return;
      }
      case 'ide': {
        if (runtime.ide && !parsed.args) {
          const sel = runtime.ide.selection;
          log('info', `Connected to ${runtime.ide.lock.ideName} (port ${runtime.ide.lock.port}).${sel ? ` Selected: ${nodePath.relative(process.cwd(), sel.filePath)} lines ${sel.startLine}-${sel.endLine}.` : ''} /ide reconnect to reconnect.`);
          return;
        }
        void runtime.connectIde().then((m) => log('info', m), (err) => log('error', `Couldn't connect to the editor: ${(err as Error).message}`));
        return;
      }
      case 'memory': {
        const facts = memoryFacts(process.cwd());
        log('info', facts.length ? `Project memory (${memoryFile(process.cwd())}):\n${facts.map((f) => `• ${f}`).join('\n')}\nThe agent adds and removes facts itself; you can also edit the file.` : `Project memory is empty. The agent saves lasting facts about this project there (${memoryFile(process.cwd())}); you can also write it yourself.`);
        break;
      }
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
      case 'goal:plan': {
        const plans = listPlans(process.cwd()).filter((p) => !p.complete);
        setOverlay({name: 'plans', plans});
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
          log('info', `Goal resumed: ${g!.text}`);
          bump(); // wakes the goal loop
          break;
        }
        if (sub === 'clear') {
          log('info', runtime.goals.clear() ? 'Goal cleared.' : 'No goal set.');
          bump();
          break;
        }
        const goal = runtime.goals.set(arg);
        log('info', `◎ Goal set: ${arg}\nThe agent keeps working until the decision model verifies it's done (evidence required). /goal pause · resume · clear`);
        const kick = runtime.goals.kickoff(goal);
        if (chat.busy) setQueued((q) => [...q, kick]);
        else void chat.send(kick).then(bump);
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
            const about = viewing;
            const stream = about
              ? (async function* () {
                  const r = await askBtwSubagent(about, runtime.config, question);
                  yield {type: 'mode' as const, mode: 'context' as const, model: `${r.model} · about ${about.name}`};
                  yield {type: 'text' as const, delta: r.answer};
                })()
              : btw(runtime.engine, runtime.config, question);
            for await (const ev of stream) {
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
          log('info', `Chat model: ${describeChatModel(value)}${viewing ? ` (the main agent's; ${viewing.name} keeps ${viewing.modelLabel ?? 'its model'})` : ''}`);
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
      case 'context': {
        // The agent on screen: a subagent's own context, or the main conversation's.
        const report = viewing
          ? subagentContextReport(viewing, runtime.config, runtime.tools.specs({subagent: true, includeMainOnly: viewing.mode === 'fork'}))
          : contextReport(runtime.engine, runtime.config, runtime.tools.specs({includeMainOnly: true}));
        if (windowed) {
          const agent = viewing?.name;
          setOverlay({name: 'context', agent});
          void report.then(
            (r) => setOverlay((o) => (o.name === 'context' ? {name: 'context', report: r, agent} : o)),
            (err) => log('error', `Context unavailable: ${(err as Error).message}`),
          );
          break;
        }
        void report.then(
          (report) => add({kind: 'context', report}),
          (err) => log('error', `Context unavailable: ${(err as Error).message}`),
        );
        break;
      }
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
        const focus = parsed.args.trim() || undefined;
        setCompacting({startedAt: Date.now(), label: `Compacting ${n} messages${focus ? ' (focused)' : ''}`});
        void runtime.engine
          .compactNow(focus)
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
      case 'settings':
        setOverlay({name: 'settings'});
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
        // The viewed agent's commands (main: its own; a subagent: the ones it started).
        const shells = runtime.tools.shells.list().filter((s) => (viewing ? s.origin?.agentId === viewing.id : !s.origin));
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
    runCommand(typed);
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
    else if (m.role === 'user') add({kind: 'user', text: displayText(m.text)});
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

export function goalSummary(g: import('../goals/manager.js').Goal): string {
  const lines = [`◎ ${g.text}`, `status: ${g.status} · ${g.rounds} continuation${g.rounds === 1 ? '' : 's'} · ${g.escalations} escalation${g.escalations === 1 ? '' : 's'}`];
  for (const c of g.checks.slice(-8)) lines.push(`  ${new Date(c.at).toLocaleTimeString()} ${c.kind === 'claim' ? 'done claim' : 'turn'}: ${c.verdict}`);
  return lines.join('\n');
}
