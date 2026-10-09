import {VaultPrompt} from './VaultPrompt.js';
import {voiceNote} from './useRein.js';
import React, {useEffect, useRef, useState} from 'react';
import {skillSourceLabel} from '../skills/index.js';
import {Box, Static, Text, useStdout} from 'ink';
import {detectGraphics, imagePaths, inlineImage} from './terminal/images.js';
import {needsBidi, visualOrder} from './bidi.js';
import {approvalNote, compactText, routeLabel, toolResultSummary} from './format.js';
import {ImportPrompt} from './ImportPrompt.js';
import {TrustHooksPrompt} from './TrustHooksPrompt.js';
import {HistorySearch} from './HistorySearch.js';
import {LoginScreen} from './LoginScreen.js';
import {ModelScreen} from './ModelScreen.js';
import {ConfigureScreen} from './ConfigureScreen.js';
import {ApprovalPrompt} from './ApprovalPrompt.js';
import {ResumeScreen} from './ResumeScreen.js';
import {RewindScreen} from './RewindScreen.js';
import {McpScreen} from './McpScreen.js';
import {PlanScreen} from './PlanScreen.js';
import {AskScreen} from './AskScreen.js';
import {PlansScreen} from './PlansScreen.js';
import {StatusBar} from './StatusBar.js';
import {UsageReport} from './UsageReport.js';
import {TextInput} from './TextInput.js';
import {rainbow, Working} from './Working.js';
import {ContextView} from './ContextView.js';
import type {Entry} from './entries.js';
import {useRein} from './useRein.js';
import {diffLines} from './fullscreen/lines.js';
import {planPreviewLines} from './planPreview.js';
import {renderMarkdown} from './markdown.js';
import {redact} from './privacy.js';
import {runtime, type Resume} from '../runtime.js';
import {shellStatusText} from '../tools/shells.js';
import {useShellsTick} from './fullscreen/Shells.js';

/** Classic renderer: a running foreground command's last lines, live, above the input. */
function ForegroundTail() {
  useShellsTick();
  const s = runtime.tools.shells.running({background: false})[0];
  if (!s) return null;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color="yellow" wrap="truncate">
        $ {s.command} <Text dimColor>· {shellStatusText(s)}{s.tty ? (s.waiting ? ' · waiting for you: ctrl+] to answer' : ' · ctrl+] to type into it') : ''} · esc interrupts</Text>
      </Text>
      {s.lines.slice(-8).map((l, i) => (
        <Text key={i} dimColor wrap="truncate">
          {'  '}
          {l || ' '}
        </Text>
      ))}
    </Box>
  );
}

/** Classic renderer: inline in the main screen, transcript in native scrollback via <Static>. */
/**
 * Images the agent made or read, drawn into the scrollback under their tool line where the
 * terminal can (terminal/images.ts). Written through Ink's stdout, which keeps the live area
 * below intact; each image once.
 */
function useInlineImages(entries: readonly {id: number; kind: string}[]) {
  const {write} = useStdout();
  const shown = useRef(new Set<number>());
  const graphics = useRef(detectGraphics());
  useEffect(() => {
    if (graphics.current === 'none' || runtime.config.inlineImages === 'off') return;
    for (const e of entries) {
      if ((e.kind !== 'tool' && e.kind !== 'user') || shown.current.has(e.id)) continue;
      shown.current.add(e.id);
      const t = e as unknown as {label?: string; ok?: boolean; result?: string; images?: string[]};
      const files = e.kind === 'user' ? (t.images ?? []) : t.ok && IMAGE_TOOLS.has(t.label!) ? imagePaths(t.result!, process.cwd()) : [];
      for (const file of files) {
        const img = inlineImage(file, graphics.current, Math.min(60, (process.stdout.columns ?? 80) - 4));
        if (img) write(img);
      }
    }
  }, [entries, write]);
}
const IMAGE_TOOLS = new Set(['ImageGen', 'Read']);
/** Right-to-left text in visual order, for terminals that don't lay it out themselves (bidi.ts). */
const rtl = (text: string) => (needsBidi(process.env, runtime.config.rtl ?? 'auto') ? text.split('\n').map(visualOrder).join('\n') : text);

export function ClassicApp({resume}: {resume: Resume}) {
  // <Static> only prints items past the count it has already rendered; remount it on /clear.
  const [generation, setGeneration] = useState(0);
  const r = useRein({
    resume,
    renderer: 'classic',
    onClear: () => {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setGeneration((g) => g + 1);
    },
  });
  const {chat, overlay} = r;
  useInlineImages(r.transcript);

  return (
    <>
      <Static key={generation} items={r.transcript}>{(e) => <EntryView key={e.id} entry={e} />}</Static>
      <Box flexDirection="column">
        {chat.live ? (
          <Box paddingLeft={2}>
            <Text>{chat.live}</Text>
          </Box>
        ) : null}
        <ForegroundTail />
        {chat.busy ? (
          <Working startedAt={chat.startedAt} phase={chat.phase} tool={chat.toolLabel} tokens={chat.tokens} queued={r.queued.length} waitUntil={chat.waitUntil} />
        ) : r.compacting ? (
          <Working startedAt={r.compacting.startedAt} phase="tool" tool={r.compacting.label} />
        ) : r.goalNote ? (
          <Working startedAt={r.goalNote.startedAt} phase="tool" tool={r.goalNote.label} />
        ) : null}
        {overlay.name === 'import' && <ImportPrompt rows={overlay.rows} onImport={() => r.finishImport(true)} onSkip={() => r.finishImport(false)} />}
        {overlay.name === 'history' && (
          <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
            <HistorySearch entries={overlay.entries} onPick={r.pickHistory} onCancel={() => r.pickHistory(undefined)} />
          </Box>
        )}
        {overlay.name === 'trust' && <TrustHooksPrompt hooks={overlay.hooks} onTrust={() => r.finishTrust(true)} onSkip={() => r.finishTrust(false)} />}
        {overlay.name === 'login' && <LoginScreen onLog={r.log} onClose={r.closeOverlay} />}
        {overlay.name === 'vault' && (
          <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
            <VaultPrompt secret={overlay.secret} onSave={(v) => r.saveVault(overlay.secret, v)} onCancel={r.closeOverlay} />
          </Box>
        )}
        {overlay.name === 'model' && <ModelScreen onLog={r.log} onClose={r.closeOverlay} />}
        {overlay.name === 'resume' && <ResumeScreen sessions={overlay.sessions} onPick={(id) => void r.pickSession(id)} onCancel={r.closeOverlay} />}
        {overlay.name === 'mcp' && <McpScreen onClose={r.closeOverlay} />}
        {overlay.name === 'plans' && <PlansScreen plans={overlay.plans} onPick={r.startPlanGoal} onNew={r.startNewPlan} onCancel={r.closeOverlay} />}
        {overlay.name === 'ask' && <AskScreen questions={overlay.questions} onDone={overlay.resolve} />}
        {overlay.name === 'plan' && <PlanScreen plan={overlay.plan} width={(process.stdout.columns ?? 100) - 4} onDecide={overlay.resolve} />}
        {overlay.name === 'rewind' && <RewindScreen points={overlay.points} onPick={(i, m) => void r.doRewind(i, m)} onCancel={r.closeOverlay} />}
        {overlay.name === 'settings' && <ConfigureScreen onClose={r.closeOverlay} onChange={r.bump} />}
        {overlay.name === 'approval' && <ApprovalPrompt req={overlay.req} onDecide={overlay.resolve} />}
        <Box borderStyle="round" borderColor={r.inputActive ? 'gray' : 'blackBright'} paddingX={1}>
          <Text color="gray">{'> '}</Text>
          <TextInput isActive={r.inputActive} value={r.draft} onChange={r.onDraft} onPaste={r.onPaste} onImagePaste={r.onImagePaste} onHistory={r.onHistory} onExternalEdit={r.onExternalEdit} placeholder={!r.ready ? 'starting…' : chat.busy ? 'queue a message, or /btw <question>' : 'message or /help'} onSubmit={r.onSubmit} />
        </Box>
        {r.inputActive && r.suggestions.length > 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            {r.suggestions.map((c) => (
              <Text key={c.name} color={c === r.selected ? 'cyan' : undefined} dimColor={c !== r.selected}>
                {`/${c.name}`.padEnd(12)}
                {c.description}
                {c.skill ? <Text dimColor> · {c.skill.plugin ? `plugin ${c.skill.plugin}` : skillSourceLabel(c.skill.source)}{c.skill.argumentHint ? ` · ${c.skill.argumentHint}` : ''}</Text> : null}
              </Text>
            ))}
          </Box>
        ) : r.inputActive && r.fileSuggestions.length > 0 ? (
          <Box flexDirection="column" paddingLeft={2}>
            {r.fileSuggestions.map((f) => (
              <Text key={f} color={f === r.fileSelected ? 'cyan' : undefined} dimColor={f !== r.fileSelected}>
                @{f}
              </Text>
            ))}
          </Box>
        ) : r.exitArmed ? (
          <Text color="yellow">{'  '}Press Ctrl+C again to exit</Text>
        ) : r.voice !== 'idle' ? (
          <Text color={r.voice === 'recording' ? 'red' : 'cyan'}>{'  '}{voiceNote(r.voice)}</Text>
        ) : (
          <StatusBar tick={r.statusTick} />
        )}
      </Box>
    </>
  );
}

function EntryView({entry: raw}: {entry: Entry}) {
  // Hide personal info: redact the entry's text fields (emails → "Claude Account 1", home → ~).
  const entry = redactEntry(raw);
  switch (entry.kind) {
    case 'banner':
      return (
        <Box marginBottom={1}>
          <Text bold color="cyan">▁▃▅▇ {entry.text}</Text>
          <Text dimColor>  /help for commands</Text>
        </Box>
      );
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="gray">{'> '}</Text>
          <Text>{rtl(entry.text)}</Text>
        </Box>
      );
    case 'assistant': {
      const md = rtl(renderMarkdown(entry.text.replace(/\s+$/, ''), (process.stdout.columns ?? 100) - 4).join('\n'));
      return entry.first ? (
        <Box marginTop={1}>
          <Text>⏺ </Text>
          <Text>{md}</Text>
        </Box>
      ) : (
        <Box paddingLeft={2}>
          <Text>{md}</Text>
        </Box>
      );
    }
    case 'compact': {
      const {stats, why} = compactText(entry.reason, entry.result, runtime.config.autoCompactPct);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color="cyan">── </Text>
            {[...'▁▃▅▇'].map((c, i) => (
              <Text key={i} color={rainbow(i * 2, 0)}>
                {c}
              </Text>
            ))}
            <Text bold color="cyan"> Conversation compacted </Text>
            <Text color="cyan">{'─'.repeat(30)}</Text>
          </Text>
          <Text>  {stats}</Text>
          <Text dimColor>  {why}</Text>
        </Box>
      );
    }
    case 'tool':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={entry.ok ? 'green' : 'red'}>⏺ </Text>
            <Text bold>{entry.label}</Text>
            <Text dimColor>
              ({entry.summary}){approvalNote(entry.approvedBy, entry.judge)}
            </Text>
          </Text>
          <Text color={entry.ok ? undefined : 'red'} dimColor={entry.ok} wrap="truncate">
            {'  ⎿ '}
            {toolResultSummary(entry.label, entry.result)}
          </Text>
          {entry.warning ? <Text color="yellow">{`  ⚠ ${entry.warning}`}</Text> : null}
          {entry.plan ? (
            <Text>{planPreviewLines(entry.plan, (process.stdout.columns ?? 100) - 2).join('\n')}</Text>
          ) : entry.diff?.length ? (
            <Text>{diffLines(entry.diff, (process.stdout.columns ?? 100) - 2, entry.summary).join('\n')}</Text>
          ) : null}
        </Box>
      );
    case 'route':
      return (
        <Text dimColor>
          {'  '}→ {routeLabel(entry.route, entry.account, entry.effort)}
          {entry.interrupted ? <Text color="yellow"> · interrupted</Text> : null}
        </Text>
      );
    case 'context':
      return <ContextView report={entry.report} />;
    case 'usage':
      return <UsageReport rows={entry.rows} jev={entry.jev} />;
    case 'update': {
      const {text, level} = entry.line;
      if (level === 'output') return <Text dimColor>{'      '}{text}</Text>;
      const color = level === 'ok' ? 'green' : level === 'warn' ? 'yellow' : level === 'error' ? 'red' : undefined;
      return <Text color={color} dimColor={!color}>{indent(level === 'info' ? `$ ${text}` : text)}</Text>;
    }
    case 'info':
      return <Text dimColor>{indent(entry.text)}</Text>;
    case 'error':
      return <Text color="red">{indent(entry.text)}</Text>;
  }
}

/** Claude-Code-style result gutter: first line gets `⎿`, continuation lines align under it. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? '  ⎿ ' : '    ') + line)
    .join('\n');
}

function redactEntry<E extends Entry>(e: E): E {
  const out: Record<string, unknown> = {...e};
  for (const k of ['text', 'summary', 'result'] as const) if (typeof out[k] === 'string') out[k] = redact(out[k] as string);
  return out as E;
}
