import {VaultPrompt} from '../VaultPrompt.js';
import {needsBidi, visualOrder} from '../bidi.js';
import {voiceNote} from '../useRein.js';
import React, {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Box, Text, useBoxMetrics, useInput, useWindowSize} from 'ink';
import {PROVIDERS, parseRef, refKey} from '../../providers/types.js';
import {formatUsd} from '../../providers/prices.js';
import {runtime, type Resume} from '../../runtime.js';
import {catalog, toRef} from '../../router/catalog.js';
import {defaultRef} from '../../router/index.js';
import {estimateTokens, renderMessages} from '../../session/transcript.js';
import {usageStore, windowLabel} from '../../store/usage.js';
import type {Entry} from '../entries.js';
import {accountLabel, commandColumn, commandListRows, listWindow, modelLabel} from '../format.js';
import {ImportPrompt} from '../ImportPrompt.js';
import {TrustHooksPrompt} from '../TrustHooksPrompt.js';
import {HistorySearch} from '../HistorySearch.js';
import {LoginScreen} from '../LoginScreen.js';
import {ModelScreen} from '../ModelScreen.js';
import {Clickable, useClickable} from '../terminal/clicks.js';
import {TextInput, wrapInput} from '../TextInput.js';
import {goalSummary, useRein} from '../useRein.js';
import {RewindScreen} from '../RewindScreen.js';
import {McpScreen} from '../McpScreen.js';
import {PlanScreen} from '../PlanScreen.js';
import {AskScreen} from '../AskScreen.js';
import {renderMarkdown} from '../markdown.js';
import {progress} from '../../plans/store.js';
import {PlansScreen} from '../PlansScreen.js';
import {isMilestoneCopy, todoLine, type Todo} from '../../tools/todo.js';
import {Splash, splashHeight, type SplashPhase} from './SplashScreen.js';

import {hidingIdentity, redact} from '../privacy.js';
import {contextPct, enabledItems, statusInfo} from '../layout.js';
import {ConfigureScreen} from '../ConfigureScreen.js';
import {ApprovalPrompt} from '../ApprovalPrompt.js';
import {ResumeScreen} from '../ResumeScreen.js';
import {LiveShell, ShellsWindow, ShellWindow, useShellsTick} from './Shells.js';
import {AgentsWindow, agentGlyph, useAgentsTick} from './Agents.js';
import {subagentStatusText, type Subagent} from '../../agents/manager.js';
import {kTokens, rainbow, useBlink, Working} from '../Working.js';
import {agentLines, assistantLines, entryLines, pendingToolLines, wrap} from './lines.js';
import {InfoWindow, Window} from './Window.js';
import {COMMANDS} from '../../commands/index.js';
import {PetView} from '../Pet.js';
import {MarketplaceScreen} from '../MarketplaceScreen.js';
import {commandEnabled, packsHint} from '../../commands/packs.js';
import {skillDirs, skillSourceLabel, type Skill} from '../../skills/index.js';
import chalk from 'chalk';
import {isEmpty, lineRange, selectedText, type Selection} from './selection.js';
import {copyToClipboard} from '../terminal/clipboard.js';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import cliTruncate from 'cli-truncate';
import {accent} from '../theme.js';

const SIDEBAR_WIDTH = 32;
const SIDEBAR_MIN_COLS = 96;
const MAX_INPUT_LINES = 6;
/** Windows with tabs keep one size whichever tab is showing (capped to the terminal). */
const TABBED_HEIGHT = 30;

/** Latest transcript entries, printed to the normal screen when fullscreen exits. */
export const lastEntries: {current: Entry[]} = {current: []};

/**
 * Fullscreen renderer (alt screen): top bar · history (virtualized, scrollable) + sidebar · activity
 * line · input · footer. The root is exactly the terminal size, so Ink never overflows into a full
 * clear and resizes redraw cleanly.
 */
export function FullscreenApp({resume}: {resume: Resume}) {
  const {columns: cols, rows} = useWindowSize();
  const r = useRein({resume, renderer: 'fullscreen', onClear: () => setScroll(0)});
  const {chat, overlay} = r;
  const [sidebarOpen, setSidebarOpen] = useState(runtime.config.sidebar ?? true);
  const [scroll, setScroll] = useState(0); // lines scrolled up from the bottom
  const [selection, setSelection] = useState<Selection | undefined>();
  const [flash, setFlash] = useState<string | undefined>();
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(undefined), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    lastEntries.current = r.entries;
  }, [r.entries]);

  const showSidebar = sidebarOpen && cols >= SIDEBAR_MIN_COLS;
  const mainWidth = cols - (showSidebar ? SIDEBAR_WIDTH : 0);
  const textWidth = Math.max(20, mainWidth - 2);

  useAgentsTick();
  const viewing = r.viewing;
  useEffect(() => setScroll(0), [r.view]);

  // History lines, cached per entry for the current width.
  // Lines pass through redact() (hide personal info): emails → "Claude Account 1", home → ~.
  const hide = hidingIdentity();
  const cache = useRef(new Map<number, {width: number; hide: boolean; lines: string[]}>());
  const dotOn = useBlink(chat.running.length > 0);
  const mainLines = useMemo(() => {
    const out: string[] = [];
    for (const e of r.entries) {
      let c = cache.current.get(e.id);
      if (!c || c.width !== textWidth || c.hide !== hide) {
        c = {width: textWidth, hide, lines: entryLines(e, textWidth).map(redact)};
        cache.current.set(e.id, c);
      }
      out.push(...c.lines);
    }
    if (chat.live) out.push(...assistantLines(chat.live, textWidth).map(redact));
    if (chat.running.length) out.push(...pendingToolLines(chat.running, textWidth, dotOn).map(redact));
    return out;
  }, [r.entries, chat.live, chat.running, dotOn, textWidth, hide]);
  // Blank-state splash: fades in at launch and out once the first message is sent (and again after
  // /clear). <Splash> animates it.
  const hasUserMessage = r.entries.some((e) => e.kind === 'user');
  const [splashPhase, setSplashPhase] = useState<{fadeIn: number; fadeOut?: number}>({fadeIn: Date.now()});
  useEffect(() => {
    if (hasUserMessage && !splashPhase.fadeOut) setSplashPhase((p) => ({...p, fadeOut: Date.now()}));
    if (!hasUserMessage && splashPhase.fadeOut) setSplashPhase({fadeIn: Date.now()}); // /clear
  }, [hasUserMessage]);
  // The animation lives in <Splash> (it owns its timer and stops it itself); here only whether it may show.
  const splash = viewing ? undefined : splashPhase;

  // Viewing a subagent: its conversation replaces the main history (recomputed on its updates).
  const lines = viewing ? agentLines(viewing, textWidth).map(redact) : mainLines;

  const toggleSidebar = () => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    void runtime.setConfig({sidebar: next});
  };

  // Keep the view anchored when scrolled up and new lines arrive.
  const prevTotal = useRef(lines.length);
  useEffect(() => {
    const delta = lines.length - prevTotal.current;
    prevTotal.current = lines.length;
    if (delta > 0) setScroll((s) => (s > 0 ? s + delta : 0));
  }, [lines.length]);

  // Input box: full terminal width; inside it the border (2), padding (2) and the "> " prompt (2).
  const inputWidth = Math.max(10, cols - 6);
  const draftLines = Math.min(MAX_INPUT_LINES, Math.max(1, r.draft ? wrapInput(r.draft, inputWidth).length : 1));
  const mainHeight = Math.max(3, rows - 1 /* top */ - 1 /* activity */ - (draftLines + 2) /* input */ - 1 /* footer */);

  const scrollBy = (n: number, viewport: number) =>
    setScroll((s) => Math.max(0, Math.min(Math.max(0, lines.length - viewport), s + n)));

  useInput((input, key) => {
    if (overlay.name !== 'none') return;
    if (key.ctrl && input === 'b') toggleSidebar();
    else if (key.pageUp) scrollBy(Math.max(1, mainHeight - 2), mainHeight);
    else if (key.pageDown) scrollBy(-Math.max(1, mainHeight - 2), mainHeight);
    else if (key.end && scroll > 0) setScroll(0);
  });

  // Commands that show information or options open a centered window over everything; the
  // conversation keeps streaming underneath. Only autocomplete stays anchored above the input.
  const windowWidth = Math.min(100, cols - 4);
  const windowText = windowWidth - 4;
  const window = (() => {
    switch (overlay.name) {
      case 'import':
        return (
          <Window title="Found existing logins" width={72} onClose={() => r.finishImport(false)}>
            <ImportPrompt bare rows={overlay.rows} onImport={() => r.finishImport(true)} onSkip={() => r.finishImport(false)} />
          </Window>
        );
      case 'history':
        return (
          <Window title="Search your messages" width={windowWidth} onClose={() => r.pickHistory(undefined)}>
            <HistorySearch entries={overlay.entries} width={windowText - 2} onPick={r.pickHistory} onCancel={() => r.pickHistory(undefined)} />
          </Window>
        );
      case 'trust':
        return (
          <Window title="This project defines hooks" width={windowWidth} onClose={() => r.finishTrust(false)} color="yellow" dismissable={false}>
            <TrustHooksPrompt bare hooks={overlay.hooks} onTrust={() => r.finishTrust(true)} onSkip={() => r.finishTrust(false)} />
          </Window>
        );
      case 'login':
        return (
          <Window title="Accounts" width={windowWidth} onClose={r.closeOverlay}>
            <LoginScreen bare onLog={r.log} onClose={r.closeOverlay} />
          </Window>
        );
      case 'vault':
        return (
          <Window title={`Vault · ${overlay.secret}`} width={windowWidth} onClose={r.closeOverlay}>
            <VaultPrompt secret={overlay.secret} onSave={(v) => r.saveVault(overlay.secret, v)} onCancel={r.closeOverlay} />
          </Window>
        );
      case 'model':
        return (
          <Window title="Models" width={windowWidth} height={TABBED_HEIGHT} onClose={r.closeOverlay}>
            <ModelScreen bare onLog={r.log} onClose={r.closeOverlay} />
          </Window>
        );
      case 'approval':
        return (
          <Window
            title={`${overlay.req.tool.name === 'shell' ? 'Approve command' : 'Approve file change'}${overlay.total > 1 ? ` (${overlay.position} of ${overlay.total})` : ''}${overlay.req.origin ? ` · subagent ${overlay.req.origin.name}` : ''}`}
            width={windowWidth} color="yellow" dismissable={false} onClose={() => overlay.resolve('deny')}>
            <ApprovalPrompt bare req={overlay.req} onDecide={overlay.resolve} />
          </Window>
        );
      case 'btw':
        return (
          <InfoWindow
            title={`btw · ${overlay.question.length > windowText - 10 ? overlay.question.slice(0, windowText - 11) + '…' : overlay.question}`}
            width={windowWidth}
            onClose={r.closeOverlay}
            lines={
              overlay.error
                ? [chalk.red(overlay.error)]
                : overlay.answer
                  ? [
                      ...renderMarkdown(overlay.answer.trim(), windowText),
                      '',
                      chalk.dim(
                        `${overlay.model ?? 'model'} · ${overlay.mode === 'fork' ? 'forked agent' : 'from the conversation'}${overlay.done ? '' : ' · answering…'} · not added to the conversation`,
                      ),
                    ]
                  : [chalk.dim('Forking the agent to answer… the main agent keeps working.')]
            }
          />
        );
      case 'plans':
        return (
          <Window title="Start a plan as a goal" width={windowWidth} onClose={r.closeOverlay}>
            <PlansScreen plans={overlay.plans} onPick={r.startPlanGoal} onNew={r.startNewPlan} onCancel={r.closeOverlay} />
          </Window>
        );
      case 'ask':
        return (
          <Window title="Questions from the agent" width={windowWidth} onClose={() => overlay.resolve(undefined)}>
            <AskScreen questions={overlay.questions} onDone={overlay.resolve} />
          </Window>
        );
      case 'plan':
        return (
          <Window title="Plan — approve to start" width={windowWidth} onClose={() => overlay.resolve('revise')}>
            <PlanScreen plan={overlay.plan} width={windowText} onDecide={overlay.resolve} />
          </Window>
        );
      case 'marketplace':
        return (
          <Window title="Marketplace" width={Math.min(140, cols - 4)} height={Math.min(rows - 4, 40)} onClose={r.closeOverlay}>
            <MarketplaceScreen width={Math.min(140, cols - 4) - 4} height={Math.min(rows - 4, 40) - 3} onClose={r.closeOverlay} log={r.log} />
          </Window>
        );
      case 'mcp':
        return (
          <Window title="MCP servers" width={windowWidth} onClose={r.closeOverlay}>
            <McpScreen onClose={r.closeOverlay} />
          </Window>
        );
      case 'rewind':
        return (
          <Window title="Rewind" width={windowWidth} onClose={r.closeOverlay}>
            <RewindScreen points={overlay.points} onPick={(i, m) => void r.doRewind(i, m)} onCancel={r.closeOverlay} />
          </Window>
        );
      case 'resume':
        return (
          <Window title="Continue a conversation" width={windowWidth} onClose={r.closeOverlay}>
            <ResumeScreen bare sessions={overlay.sessions} onPick={(id) => void r.pickSession(id)} onCancel={r.closeOverlay} />
          </Window>
        );
      case 'goal':
        return runtime.goals.goal ? (
          <InfoWindow
            title="Goal"
            width={windowWidth}
            onClose={r.closeOverlay}
            lines={goalSummary(runtime.goals.goal).split('\n').flatMap((l) => wrap(l, windowText)).concat(['', chalk.dim('/goal pause · /goal resume · /goal clear')])}
          />
        ) : null;
      case 'agents':
        return (
          <AgentsWindow
            width={windowWidth}
            onOpen={(id) => {
              r.setView(id);
              r.closeOverlay();
            }}
            onClose={r.closeOverlay}
          />
        );
      case 'shell':
        return <ShellWindow id={overlay.id} width={windowWidth} onClose={r.closeOverlay} />;
      case 'shells':
        return <ShellsWindow width={windowWidth} agent={viewing} onOpen={(id) => r.setOverlay({name: 'shell', id})} onClose={r.closeOverlay} />;
      case 'settings':
        return (
          <Window title="Configure" width={windowWidth} height={TABBED_HEIGHT} onClose={r.closeOverlay}>
            <ConfigureScreen bare onClose={r.closeOverlay} onChange={r.bump} initialTab={overlay.tab} />
          </Window>
        );
      case 'usage':
        return (
          <InfoWindow
            title="Usage"
            width={windowWidth}
            onClose={r.closeOverlay}
            lines={overlay.data ? entryLines({id: -1, kind: 'usage', ...overlay.data}, windowText).slice(1) : ['Checking usage…']}
          />
        );
      case 'context':
        return (
          <InfoWindow
            title={overlay.agent ? `Context — subagent ${overlay.agent}` : 'Context'}
            width={windowWidth}
            onClose={r.closeOverlay}
            lines={overlay.report ? entryLines({id: -1, kind: 'context', report: overlay.report}, windowText).slice(1) : ['Measuring…']}
          />
        );
      case 'help':
        return <InfoWindow title="Commands" width={windowWidth} onClose={r.closeOverlay} lines={helpLines(windowText, r.skills)} />;
      case 'update':
        return (
          <InfoWindow
            title={r.updating ? 'Updating…' : 'Update finished'}
            width={windowWidth}
            follow
            onClose={r.closeOverlay}
            lines={r.updateLog.length ? r.updateLog.flatMap((line) => entryLines({id: -1, kind: 'update', line}, windowText)) : ['Starting…']}
          />
        );
      default:
        return null;
    }
  })();

  // The command and file lists span the chat column (not the sidebar), a column in from each side.
  const panelWidth = Math.max(20, mainWidth - 2);
  const panel = (() => {
    if (r.inputActive && r.suggestions.length > 0) {
      const win = listWindow(r.suggestions.length, Math.max(0, r.suggestions.indexOf(r.selected!)), commandListRows(rows));
      const nameCol = commandColumn(r.suggestions.map((c) => c.name));
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={panelWidth}>
          {win.above ? <Text dimColor>  ↑ {win.above} more</Text> : null}
          {r.suggestions.slice(win.start, win.end).map((c, j) => (
            <Clickable
              key={c.name}
              onClick={() => {
                r.onDraft('');
                r.runCommand(`/${c.name}`);
              }}
              onHover={() => r.setSuggestIndex(win.start + j)}
            >
              <Text color={c === r.selected ? accent() : undefined} dimColor={c !== r.selected} wrap="truncate">
                {c === r.selected ? '❯ ' : '  '}
                {nameCol(c.name)}
                {c.description}
                {c.skill && c.skill.source !== 'builtin' ? <Text dimColor> · {c.skill.plugin ? `plugin ${c.skill.plugin}` : skillSourceLabel(c.skill.source)}{c.skill.argumentHint ? ` · ${c.skill.argumentHint}` : ''}</Text> : null}
              </Text>
            </Clickable>
          ))}
          {win.below ? <Text dimColor>  ↓ {win.below} more</Text> : null}
        </Box>
      );
    }
    if (r.inputActive && r.fileSuggestions.length > 0) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={panelWidth}>
          {r.fileSuggestions.map((f) => (
            <Clickable key={f} onClick={() => r.acceptFile(f)}>
              <Text color={f === r.fileSelected ? accent() : undefined} dimColor={f !== r.fileSelected} wrap="truncate">
                {f === r.fileSelected ? '❯ ' : '  '}@{f}
              </Text>
            </Clickable>
          ))}
          <Text dimColor>tab/enter insert · ↑↓ select — the file's contents go with your message</Text>
        </Box>
      );
    }
    return null;
  })();

  return (
    <Box flexDirection="column" height={rows}>
      <TopBar cols={cols} tick={r.statusTick} sidebarOpen={showSidebar} onToggleSidebar={toggleSidebar} togglePlanMode={r.togglePlanMode} run={r.runCommand} openModel={() => r.setOverlay({name: 'model'})} openShells={r.openShells} viewing={viewing} setView={r.setView} />
      <Box flexDirection="row" height={mainHeight}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} height={mainHeight} overflow="hidden">
          <History
            width={textWidth}
            splash={splash}
            lines={lines}
            scroll={scroll}
            onScroll={(n, vp) => scrollBy(n, vp)}
            selection={selection}
            onSelect={setSelection}
            onCopy={(text) => {
              void copyToClipboard(text).then((ok) => setFlash(ok ? `Copied ${text.length} characters` : 'Copy failed (no clipboard tool)'));
            }}
          />
          {panel ? <Box flexShrink={0} paddingX={1}>{panel}</Box> : <Box flexShrink={0}><LiveShell width={textWidth} agentId={viewing?.id} onOpen={(id) => r.setOverlay({name: 'shell', id})} /></Box>}
        </Box>
        {showSidebar ? <Sidebar width={SIDEBAR_WIDTH} height={mainHeight} tick={r.statusTick} run={r.runCommand} view={r.view} setView={r.setView} /> : null}
      </Box>
      <Box height={1} paddingLeft={1}>
        {flash ? (
          <Text color="green">✓ {flash}</Text>
        ) : viewing ? (
          runtime.agents.isActive(viewing) ? (
            <Working
              startedAt={viewing.startedAt}
              phase="tool"
              tool={viewing.status === 'checking' ? 'Checking completion' : viewing.status === 'starting' ? 'Starting' : runningToolLabel(viewing) ?? `${viewing.name} working`}
              tokens={viewing.tokens}
            />
          ) : (
            <Text dimColor>
              {viewing.name} {subagentStatusText(viewing)} · type to message it · <Text color={accent()}>◂ main</Text> in the sidebar or /agent main to go back
            </Text>
          )
        ) : chat.busy ? (
          <Working startedAt={chat.startedAt} phase={chat.phase} tool={chat.toolLabel} tokens={chat.tokens} queued={r.queued.length} waitUntil={chat.waitUntil} />
        ) : r.compacting ? (
          <Working startedAt={r.compacting.startedAt} phase="tool" tool={r.compacting.label} />
        ) : r.goalNote ? (
          <Working startedAt={r.goalNote.startedAt} phase="tool" tool={r.goalNote.label} />
        ) : scroll > 0 ? (
          <Clickable onClick={() => setScroll(0)}>
            <Text color="yellow">↓ {scroll} lines below · End or click to jump to latest</Text>
          </Clickable>
        ) : (
          <Text> </Text>
        )}
      </Box>
      <Box borderStyle="round" borderColor={r.inputActive ? accent() : 'gray'} paddingX={1} width={cols} height={draftLines + 2} flexShrink={0} overflow="hidden">
        <Text color={accent()}>{'> '}</Text>
        <Box flexDirection="column" width={inputWidth} justifyContent="flex-end" overflow="hidden">
          <TextInput width={inputWidth} maxLines={MAX_INPUT_LINES} isActive={r.inputActive} value={r.draft} onChange={r.onDraft} onPaste={r.onPaste} onImagePaste={r.onImagePaste} onHistory={r.onHistory} onExternalEdit={r.onExternalEdit} placeholder={!r.ready ? 'starting…' : viewing ? `message ${viewing.name} (subagent)…` : chat.busy ? 'queue a message, or /btw <question>' : 'message, / for commands'} onSubmit={r.onSubmit} />
        </Box>
      </Box>
      <Box height={1} paddingX={1}>
        {r.exitArmed ? (
          <Text color="yellow">Press Ctrl+C again to exit</Text>
        ) : r.voice !== 'idle' ? (
          <Text color={r.voice === 'recording' ? 'red' : accent()}>{voiceNote(r.voice)}</Text>
        ) : (
          <Text dimColor wrap="truncate">
            esc interrupt · ctrl+c stop (twice to exit) · wheel/PgUp scroll · ⇧↵ / ⌥↵ / \↵ newline · ctrl+b sidebar
          </Text>
        )}
      </Box>
      {window}
    </Box>
  );
}

function helpLines(width: number, skills: Skill[]): string[] {
  const dirs = skillDirs();
  const commands = COMMANDS.filter((c) => commandEnabled(c.name));
  const col = commandColumn(commands.map((c) => c.name));
  // Skills from Claude Code / Codex plugins come last, one sentence each (theirs run to paragraphs).
  const fromPlugin = (s: Skill) => s.source === 'plugin' || s.source === 'codex';
  const own = skills.filter((s) => !fromPlugin(s));
  const plugins = skills.filter(fromPlugin);
  const skillCol = commandColumn(skills.map((s) => s.name));
  const firstSentence = (t: string) => t.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? t;
  return [
    ...commands.flatMap((c) => wrap(c.usage, width, chalk.cyan(col(c.name)))),
    ...wrap(chalk.dim(packsHint()), width),
    '',
    chalk.bold('Skills') + chalk.dim(`  name clashes: built-in → ${dirs.project} (project) → ${dirs.global} (global)`),
    ...(own.length ? own.flatMap((s) => wrap(`${s.description}${s.source === 'builtin' ? '' : ` ${chalk.dim(`(${s.source})`)}`}`, width, chalk.magenta(skillCol(s.name)))) : [chalk.dim('  none yet — /skill:create makes one')]),
    ...(plugins.length ? ['', chalk.bold('From plugins'), ...plugins.flatMap((s) => wrap(firstSentence(s.description), width, chalk.magenta(skillCol(s.name))))] : []),
    '',
    ...wrap('esc interrupts a reply (or closes a window) · wheel / PgUp / PgDn scroll · drag to select & copy · ctrl+b sidebar · shift/option+enter or \\+enter for a new line · rein --continue picks a conversation', width).map((l) => chalk.dim(l)),
  ];
}


type HistoryProps = {
  /** Text columns available (pane minus padding); every line is clipped to it. */
  width: number;
  lines: string[];
  scroll: number;
  onScroll(n: number, viewport: number): void;
  selection: Selection | undefined;
  onSelect(sel: Selection | undefined): void;
  onCopy(text: string): void;
  /** Blank-state graphic, drawn centered in the empty rows above the messages (if it fits). */
  splash?: SplashPhase;
};

/**
 * Virtualized history: renders only the visible window of `lines`. Drag selects text (the
 * terminal's own selection is unavailable while mouse reporting is on); release copies it.
 * Dragging past the top/bottom edge scrolls.
 */
/** Right-to-left text in visual order where the terminal doesn't do it (display only: copying uses the text as written). */
const rtlLine = (line: string) => (needsBidi(process.env, runtime.config.rtl ?? 'auto') ? visualOrder(line) : line);

function History({width, lines, scroll, onScroll, selection, onSelect, onCopy, splash}: HistoryProps) {
  const ref = useRef(null);
  const {height} = useBoxMetrics(ref);
  const viewport = Math.max(1, height);
  const end = Math.max(0, lines.length - scroll);
  const start = Math.max(0, end - viewport);
  const visible = lines.slice(start, end);
  // Content is bottom-aligned: when there are fewer lines than rows, row 0 isn't line `start`.
  const topPad = viewport - visible.length;
  const posAt = (local: {x: number; y: number}) => ({
    line: Math.max(0, Math.min(lines.length - 1, start + local.y - topPad)),
    col: Math.max(0, local.x - 1), // paddingX
  });
  const sel = useRef<Selection | undefined>(undefined);
  useClickable(ref, {
    onWheel: (dir) => onScroll(dir === -1 ? 3 : -3, viewport),
    onDragStart: (local) => {
      sel.current = {anchor: posAt(local), focus: posAt(local)};
      onSelect(undefined);
    },
    onDrag: (local) => {
      if (!sel.current) return;
      if (local.y < 0) onScroll(1, viewport);
      else if (local.y >= viewport) onScroll(-1, viewport);
      sel.current = {...sel.current, focus: posAt(local)};
      onSelect(sel.current);
    },
    onDragEnd: (local) => {
      if (!sel.current) return;
      const done = {...sel.current, focus: posAt(local)};
      sel.current = undefined;
      if (isEmpty(done)) return onSelect(undefined); // plain click clears the selection
      onSelect(done);
      const text = selectedText(done, lines);
      if (text.trim()) onCopy(text);
    },
  });
  // The splash sits in the empty space above the messages, vertically centered; skipped if cramped.
  const showSplash = splash && topPad >= splashHeight(width) + 2;
  return (
    <Box ref={ref} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" justifyContent="flex-end" paddingX={1}>
      {showSplash ? (
        <Box flexDirection="column" height={topPad} justifyContent="center" flexShrink={0}>
          <Splash width={width} phase={splash!} />
        </Box>
      ) : null}
      {visible.map((line, i) => {
        const index = start + i;
        const plain = selection ? stripAnsi(line) : '';
        const range = selection ? lineRange(selection, index, plain.length) : undefined;
        if (!range) {
          // Backstop: a line wider than the pane would widen the column and push the sidebar.
          return (
            <Text key={i} wrap="truncate">
              {(stringWidth(line) > width ? cliTruncate(rtlLine(line), width) : rtlLine(line)) || ' '}
            </Text>
          );
        }
        return (
          <Text key={i} wrap="truncate">
            {plain.slice(0, range[0])}
            <Text inverse>{plain.slice(range[0], range[1])}</Text>
            {plain.slice(range[1]) || ' '}
          </Text>
        );
      })}
    </Box>
  );
}

function TopBar(props: {cols: number; tick: number; sidebarOpen: boolean; onToggleSidebar(): void; togglePlanMode(): void; run(cmd: string): void; openModel(): void; openShells(): void; viewing?: Subagent; setView(v: 'main' | number): void}) {
  useShellsTick();
  useAgentsTick();
  const background = runtime.tools.shells.running({background: true}).filter((s) => (props.viewing ? s.origin?.agentId === props.viewing.id : !s.origin)).length;
  const activeAgents = runtime.agents.running();
  const openAgents = () => (activeAgents.length === 1 ? props.setView(activeAgents[0]!.id) : props.run('/agents'));
  const [, setUsageTick] = useState(0);
  useEffect(() => usageStore.subscribe(() => setUsageTick((t) => t + 1)), []);
  void props.tick;
  const info = statusInfo(props.viewing);
  const items = enabledItems('status', runtime.config);
  /** Each status segment's plain text (for fitting the bar to the terminal width). */
  const segText = (id: string): string | undefined => {
    switch (id) {
      case 'model':
        return info.model;
      case 'account':
        return info.account;
      case 'usage':
        return info.usage || undefined;
      case 'context':
        return `ctx ${info.context}%`;
      case 'decider':
        return `decides: ${info.decider}`;
      case 'advisor':
        return `advisor: ${info.advisor}`;
      case 'approvals':
        return `edits: ${info.approvals}`;
      case 'messages':
        return `${info.messages} msgs`;
      default:
        return undefined;
    }
  };
  const segment = (id: string): ReactNode => {
    switch (id) {
      case 'model':
        return (
          <Seg key={id} onClick={props.openModel}>
            <Text color={accent()}>{info.model}</Text>
          </Seg>
        );
      case 'account':
        return (
          <Seg key={id} onClick={() => props.run('/usage')}>
            <Text>{info.account}</Text>
          </Seg>
        );
      case 'usage':
        return info.usage ? (
          <Seg key={id} onClick={() => props.run('/usage')}>
            <Text dimColor>{info.usage}</Text>
          </Seg>
        ) : null;
      case 'context':
        return (
          <Seg key={id} onClick={() => props.run('/context')}>
            <Text dimColor>ctx </Text>
            <Text color={info.context >= 80 ? 'red' : info.context >= 50 ? 'yellow' : 'green'}>{info.context}%</Text>
          </Seg>
        );
      case 'decider':
        return (
          <Seg key={id} onClick={props.openModel}>
            <Text dimColor>decides: </Text>
            <Text>{info.decider}</Text>
          </Seg>
        );
      case 'advisor':
        return (
          <Seg key={id} onClick={props.openModel}>
            <Text dimColor>advisor: </Text>
            <Text color={info.advisor === 'off' ? 'gray' : 'magenta'}>{info.advisor}</Text>
          </Seg>
        );
      case 'approvals':
        return (
          <Seg key={id} onClick={() => props.run('/settings')}>
            <Text dimColor>edits: </Text>
            <Text color={info.approvals === 'bypass' ? 'red' : info.approvals === 'auto' ? 'yellow' : 'green'}>{info.approvals}</Text>
          </Seg>
        );
      case 'messages':
        return (
          <Seg key={id} onClick={() => props.run('/context')}>
            <Text dimColor>{info.messages} msgs</Text>
          </Seg>
        );
      default:
        return null;
    }
  };
  // Segments in display order with their widths (" │ " + text) and drop priority: when the bar is
  // wider than the terminal, the least important go first — configured items from the end of the
  // list, then background/agents/goal/plan; nothing ever wraps or runs off-screen.
  type Part = {key: string; width: number; drop: number; node: ReactNode};
  const parts: Part[] = [];
  if (props.viewing)
    parts.push({
      key: 'viewing',
      width: 3 + `◂ main · viewing ${props.viewing.name}`.length,
      drop: 1000,
      node: (
        <Seg key="viewing" onClick={() => props.setView('main')}>
          <Text color={accent()}>◂ main</Text>
          <Text dimColor> · viewing </Text>
          <Text color="magenta" bold>
            {props.viewing.name}
          </Text>
        </Seg>
      ),
    });
  const configured = items.filter((id) => id !== 'sidebarToggle');
  configured.forEach((id, i) => {
    const text = segText(id);
    const node = segment(id);
    if (text && node) parts.push({key: id, width: 3 + stringWidth(text), drop: configured.length - i, node});
  });
  if (runtime.planMode)
    parts.push({
      key: 'plan',
      width: 3 + 11,
      drop: 900,
      node: (
        <Seg key="plan" onClick={props.togglePlanMode}>
          <Text color="yellow" bold>
            ⏸ plan mode
          </Text>
        </Seg>
      ),
    });
  // The connected editor, and how much is selected there (that selection goes with the next message).
  if (runtime.ide) {
    const sel = runtime.ide.selection;
    const ideText = `⧉ ${runtime.ide.lock.ideName}${sel ? ` · ${sel.endLine - sel.startLine + 1} lines` : ''}`;
    parts.push({
      key: 'ide',
      width: 3 + stringWidth(ideText),
      drop: 850,
      node: (
        <Seg key="ide" onClick={() => props.run('/ide')}>
          <Text color={accent()}>{ideText}</Text>
        </Seg>
      ),
    });
  }
  const goal = runtime.goals.goal;
  const goalPlan = goal?.plan ? runtime.goals.plan() : undefined;
  const goalText = goal ? `◎ goal · ${goal.status}${goalPlan ? ` · ${progress(goalPlan).done}/${progress(goalPlan).total}` : ''}` : '';
  if (goal)
    parts.push({
      key: 'goal',
      width: 3 + goalText.length,
      drop: 800,
      node: (
        <Seg key="goal" onClick={() => props.run('/goal')}>
          <Text color={goal.status === 'active' ? accent() : goal.status === 'done' ? 'green' : 'yellow'}>{goalText}</Text>
        </Seg>
      ),
    });
  if (activeAgents.length) {
    const t = `● ${activeAgents.length} agent${activeAgents.length === 1 ? '' : 's'}`;
    parts.push({
      key: 'agents',
      width: 3 + t.length,
      drop: 700,
      node: (
        <Seg key="agents" onClick={openAgents}>
          <Text color="magenta">{t}</Text>
        </Seg>
      ),
    });
  }
  if (background) {
    const t = `● ${background} background${background === 1 ? '' : ' processes'}`;
    parts.push({
      key: 'background',
      width: 3 + t.length,
      drop: 600,
      node: (
        <Seg key="background" onClick={props.openShells}>
          <Text color="yellow">{t}</Text>
        </Seg>
      ),
    });
  }
  const toggle = items.includes('sidebarToggle');
  const room = props.cols - 'XXXX Rein '.length - (toggle ? 4 : 0);
  const shown = new Set(parts.map((p) => p.key));
  let used = parts.reduce((n, p) => n + p.width, 0);
  for (const p of [...parts].sort((x, y) => x.drop - y.drop)) {
    if (used <= room) break;
    shown.delete(p.key);
    used -= p.width;
  }
  return (
    <Box height={1} width={props.cols} overflow="hidden">
      <Text bold>
        {[...'▁▃▅▇'].map((c, i) => (
          <Text key={i} color={rainbow(i * 2, 0)}>
            {c}
          </Text>
        ))}{' '}
        Rein{' '}
      </Text>
      {parts.filter((p) => shown.has(p.key)).map((p) => p.node)}
      <Box flexGrow={1} />
      {toggle ? (
        <Clickable onClick={props.onToggleSidebar}>
          <Text color={props.sidebarOpen ? accent() : 'gray'}> [≡]</Text>
        </Clickable>
      ) : null}
    </Box>
  );
}

function Seg({children, onClick}: {children: ReactNode; onClick(): void}) {
  return (
    <>
      <Text dimColor> │ </Text>
      <Clickable onClick={onClick}>{children}</Clickable>
    </>
  );
}

function Heading({children}: {children: string}) {
  return (
    <Text dimColor bold>
      {children}
    </Text>
  );
}

/** Sidebar: the sections chosen in /settings, in order. */
function Sidebar({width, height, tick, run, view, setView}: {width: number; height: number; tick: number; run(cmd: string): void; view: 'main' | number; setView(v: 'main' | number): void}) {
  const [, setUsageTick] = useState(0);
  useEffect(() => usageStore.subscribe(() => setUsageTick((t) => t + 1)), []);
  useEffect(() => {
    const on = () => setUsageTick((t) => t + 1); // milestones ticked off
    runtime.goals.on('change', on);
    return () => void runtime.goals.off('change', on);
  }, []);
  void tick;
  const inner = width - 3;
  // A goal working from a plan shows its milestones first; then the task list whenever the agent
  // keeps one (like Claude Code's todo list).
  const todos = sidebarTodos();
  const planGoal = runtime.goals.goal?.plan ? ['plan'] : [];
  const sections = [...planGoal, ...(todos.length && todos.some((t) => t.status !== 'completed') ? ['tasks'] : []), ...enabledItems('sidebar', runtime.config)];
  const render = (id: string): ReactNode => {
    switch (id) {
      case 'plan':
        return <PlanSection inner={inner} run={run} />;
      case 'tasks':
        return <TasksSection inner={inner} />;
      case 'agents':
        return <AgentsSection inner={inner} view={view} setView={setView} />;
      case 'accounts':
        return <AccountsSection inner={inner} run={run} />;
      case 'models':
        return <ModelsSection inner={inner} run={run} />;
      case 'context':
        return <ContextSection inner={inner} run={run} viewing={typeof view === 'number' ? runtime.agents.get(view) : undefined} />;
      case 'routing':
        return <RoutingSection inner={inner} />;
      case 'session':
        return <SessionSection run={run} />;
      case 'shortcuts':
        return <ShortcutsSection />;
      default:
        return null;
    }
  };
  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" borderLeft borderTop={false} borderRight={false} borderBottom={false} borderColor="gray" paddingLeft={1} overflow="hidden">
      {sections.map((id, i) => (
        <Box key={id} flexDirection="column" marginTop={i ? 1 : 0} flexShrink={0}>
          {render(id)}
        </Box>
      ))}
      {!sections.length && (
        <Clickable onClick={() => run('/settings')}>
          <Text dimColor>empty · /settings</Text>
        </Clickable>
      )}
      <Box flexGrow={1} />
      <PetView pets={runtime.pets} />
    </Box>
  );
}

const miniBar = (pct: number, cells = 8) => {
  const n = Math.round((Math.min(100, pct) / 100) * cells);
  return {fill: '█'.repeat(n), rest: '░'.repeat(cells - n), color: pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green'};
};

/**
 * main + subagents that are running or being viewed (finished ones drop off once you look away;
 * /agents lists them all). Click to switch the main pane to that agent.
 */
function AgentsSection({inner, view, setView}: {inner: number; view: 'main' | number; setView(v: 'main' | number): void}) {
  const shown = runtime.agents.list().filter((a) => runtime.agents.isActive(a) || a.id === view);
  return (
    <>
      <Heading>AGENTS</Heading>
      <Clickable onClick={() => setView('main')}>
        <Text color={view === 'main' ? accent() : undefined} wrap="truncate">
          {view === 'main' ? '▸ ' : '  '}
          <Text bold={view === 'main'}>main</Text>
          {runtime.engine?.isBusy ? <Text color="yellow"> ●</Text> : null}
        </Text>
      </Clickable>
      {shown.map((a) => {
        const g = agentGlyph(a);
        return (
          <Clickable key={a.id} onClick={() => setView(a.id)}>
            <Text color={view === a.id ? accent() : undefined} wrap="truncate">
              {view === a.id ? '▸ ' : '  '}
              <Text color={g.color}>{g.g} </Text>
              <Text bold={view === a.id}>{truncate(a.name, Math.max(6, inner - 14))}</Text>
              <Text dimColor> {a.modelLabel ?? a.requested}</Text>
            </Text>
          </Clickable>
        );
      })}
    </>
  );
}

function AccountsSection({inner, run}: {inner: number; run(cmd: string): void}) {
  const accounts = [...new Map(catalog.all().flatMap((m) => m.accountIds).map((id) => [id, catalog.account(id)])).values()].filter((a) => !!a);
  return (
    <>
      <Heading>ACCOUNTS</Heading>
      {accounts.map((a) => {
        const snap = usageStore.get(a!.id);
        return (
          <Clickable key={a!.id} onClick={() => run('/usage')}>
            <Box flexDirection="column">
              <Text wrap="truncate">
                <Text bold>{PROVIDERS[a!.provider].name}</Text> <Text dimColor>{truncate(accountLabel(a!), inner - 8)}</Text>
              </Text>
              {(snap?.windows ?? []).map((w) => {
                // Bar fills the row: ' ' + 7-char label + bar + ' ' + 4-char percent.
                const b = miniBar(w.usedPct, Math.max(4, inner - 13));
                return (
                  <Text key={w.windowMins} wrap="truncate">
                    {' '}
                    {windowLabel(w.windowMins).padEnd(7)}
                    <Text color={b.color}>{b.fill}</Text>
                    <Text dimColor>{b.rest}</Text> {`${Math.round(w.usedPct)}%`.padStart(4)}
                  </Text>
                );
              })}
            </Box>
          </Clickable>
        );
      })}
      {!accounts.length && (
        <Clickable onClick={() => run('/login')}>
          <Text color="yellow">+ add an account</Text>
        </Clickable>
      )}
    </>
  );
}

function ModelsSection({inner, run}: {inner: number; run(cmd: string): void}) {
  const cfg = runtime.config;
  const selected = cfg.chatModel ?? (defaultRef(cfg) ? refKey(defaultRef(cfg)!) : '');
  const models = [{value: 'auto', label: 'auto'}, ...catalog.all().map((m) => ({value: refKey(toRef(m)), label: `${m.label}`}))];
  return (
    <>
      <Heading>CHAT MODEL</Heading>
      {models.map((m) => (
        <Clickable key={m.value} onClick={() => run(`/model ${m.value}`)}>
          <Text color={m.value === selected ? accent() : undefined} dimColor={m.value !== selected} wrap="truncate">
            {m.value === selected ? '● ' : '○ '}
            {truncate(m.label + (m.value === 'auto' ? '' : ` · ${PROVIDERS[parseRef(m.value)!.provider].name}`), inner - 2)}
          </Text>
        </Clickable>
      ))}
    </>
  );
}

function ContextSection({inner, run, viewing}: {inner: number; run(cmd: string): void; viewing?: Subagent}) {
  const pct = contextPct(viewing);
  const b = miniBar(pct, Math.max(4, inner - 5)); // bar + ' ' + 4-char percent fills the row
  return (
    <>
      <Heading>{viewing ? `CONTEXT · ${viewing.name}` : 'CONTEXT'}</Heading>
      <Clickable onClick={() => run('/context')}>
        <Text>
          <Text color={b.color}>{b.fill}</Text>
          <Text dimColor>{b.rest}</Text> {`${pct}%`.padStart(4)}
        </Text>
      </Clickable>
    </>
  );
}

function RoutingSection({inner}: {inner: number}) {
  const info = statusInfo();
  return (
    <>
      <Heading>AUTO ROUTING</Heading>
      <Text dimColor wrap="truncate">
        decides: {truncate(info.decider, inner - 9)}
      </Text>
      <Text wrap="wrap">{runtime.lastDecision ? truncate(runtime.lastDecision, inner * 2) : <Text dimColor>no decisions yet{runtime.config.chatModel === 'auto' ? '' : ' (chat model is fixed)'}</Text>}</Text>
    </>
  );
}

/** The goal's plan: progress bar and milestones (✓ done, ▸ next, ○ later). */
function PlanSection({inner, run}: {inner: number; run(cmd: string): void}) {
  const g = runtime.goals.goal;
  const p = runtime.goals.plan();
  if (!g || !p) return null;
  const {done, total, pct} = progress(p);
  const b = miniBar(pct, Math.max(4, inner - 5));
  const next = p.milestones.findIndex((m) => !m.done);
  return (
    <>
      <Clickable onClick={() => run('/goal')}>
        <Heading>{`GOAL · ${done}/${total}${g.status === 'active' ? '' : ` · ${g.status}`}`}</Heading>
      </Clickable>
      <Text wrap="truncate" bold>
        {truncate(p.title, inner)}
      </Text>
      <Text>
        <Text color={pct === 100 ? 'green' : accent()}>{b.fill}</Text>
        <Text dimColor>{b.rest}</Text> {`${pct}%`.padStart(4)}
      </Text>
      {p.milestones.slice(0, 12).map((m, i) => (
        <Text key={i} wrap="truncate" color={i === next ? accent() : m.done ? 'green' : undefined} dimColor={!m.done && i !== next}>
          {truncate(`${m.done ? '✓' : i === next ? '▸' : '○'} ${m.text}`, inner)}
        </Text>
      ))}
      {p.milestones.length > 12 && <Text dimColor>… {p.milestones.length - 12} more</Text>}
    </>
  );
}

/** The task list, minus tasks that repeat the active plan's milestones (shown above it already). */
function sidebarTodos(): Todo[] {
  const todos = runtime.engine?.transcript.todos ?? [];
  const milestones = runtime.goals.goal?.plan ? (runtime.goals.plan()?.milestones.map((m) => m.text) ?? []) : [];
  return milestones.length ? todos.filter((t) => !isMilestoneCopy(t, milestones)) : todos;
}

function TasksSection({inner}: {inner: number}) {
  const todos = sidebarTodos();
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <>
      <Heading>{`TASKS ${done}/${todos.length}`}</Heading>
      {todos.slice(0, 12).map((t, i) => (
        <Text key={i} wrap="truncate" color={t.status === 'in_progress' ? accent() : undefined} dimColor={t.status === 'completed'} strikethrough={t.status === 'completed'}>
          {truncate(todoLine(t), inner)}
        </Text>
      ))}
      {todos.length > 12 && <Text dimColor>… {todos.length - 12} more</Text>}
    </>
  );
}

function SessionSection({run}: {run(cmd: string): void}) {
  const t = runtime.engine?.sessionTokens ?? {uncached: 0, cached: 0, output: 0};
  const row = (label: string, n: number) => (
    <Text key={label} wrap="truncate">
      <Text dimColor>{label.padEnd(10)}</Text>
      {kTokens(n)}
    </Text>
  );
  return (
    <>
      <Heading>SESSION</Heading>
      <Text dimColor wrap="truncate">
        {runtime.engine?.transcript.messages.length ?? 0} messages{runtime.engine?.transcript.summary ? ' · summarized' : ''}
      </Text>
      {row('uncached', t.uncached)}
      {row('cached', t.cached)}
      {row('received', t.output)}
      {t.usd !== undefined && (
        <Clickable onClick={() => run('/cost')}>
          <Text wrap="truncate">
            <Text dimColor>{'cost'.padEnd(10)}</Text>≈{formatUsd(t.usd)}
          </Text>
        </Clickable>
      )}
      <Clickable onClick={() => run('/compact')}>
        <Text color="gray">↻ compact</Text>
      </Clickable>
      <Clickable onClick={() => run('/login')}>
        <Text color="gray">⚙ accounts</Text>
      </Clickable>
      <Clickable onClick={() => run('/settings')}>
        <Text color="gray">☰ settings</Text>
      </Clickable>
    </>
  );
}

function ShortcutsSection() {
  return (
    <>
      <Heading>SHORTCUTS</Heading>
      {[
        ['esc', 'interrupt / close'],
        ['wheel', 'scroll history'],
        ['drag', 'select & copy'],
        ['⇧↵ \\↵', 'new line'],
        ['ctrl+b', 'sidebar'],
        ['/', 'commands'],
      ].map(([k, v]) => (
        <Text key={k} wrap="truncate">
          <Text color={accent()}>{k!.padEnd(8)}</Text>
          <Text dimColor>{v}</Text>
        </Text>
      ))}
    </>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);

/** The subagent's tool call in flight, e.g. `Edit(src/a.ts)`. */
function runningToolLabel(a: Subagent): string | undefined {
  const last = [...a.events].reverse().find((e) => e.kind === 'tool');
  return last && last.kind === 'tool' && last.ok === undefined ? `${last.label}(${last.summary})` : undefined;
}
