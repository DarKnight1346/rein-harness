import {useEffect, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {TabBar} from './TabBar.js';
import {runtime} from '../runtime.js';
import {getJevKey} from '../store/secrets.js';
import {Clickable} from './terminal/clicks.js';
import {currentValue, describe, effortOptions, optionsFor, SECTIONS, type Option} from './modelOptions.js';
export {describeChatModel, resolveModelQuery} from './modelOptions.js';

/** Rows of the model list shown per section; keeps the overlay short so it never fills the screen. */
const MAX_ROWS = 9;

export function ModelScreen({onClose, onLog, bare}: {onClose(): void; onLog(kind: 'info' | 'error', text: string): void; bare?: boolean}) {
  const [section, setSection] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [hasJev, setHasJev] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    void getJevKey().then((k) => setHasJev(!!k));
  }, []);

  const cfg = runtime.config;
  const sec = SECTIONS[section]!;
  const options = optionsFor(sec.id, hasJev, cfg);
  const current = currentValue(sec.id, cfg);

  // Choosing a chat model continues to its effort level (auto, the model's default, or a level).
  const [effortStep, setEffortStep] = useState<{label: string; options: Option[]} | undefined>();
  const choose = (idx: number) => {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    void runtime.setConfig({[sec.key]: opt.value}).then(() => {
      onLog('info', `${sec.title}: ${opt.label}`);
      setTick((t) => t + 1);
      if (sec.id === 'chat') {
        setEffortStep({label: opt.label, options: effortOptions(opt.value)});
        setCursor(Math.max(0, effortOptions(opt.value).findIndex((o) => o.value === (cfg.chatEffort ?? 'auto'))));
      }
    });
  };
  const chooseEffort = (idx: number) => {
    const opt = effortStep?.options[idx];
    if (!opt) return;
    void runtime.setConfig({chatEffort: opt.value}).then(() => {
      onLog('info', `Effort: ${opt.label}`);
      setEffortStep(undefined);
      setCursor(0);
    });
  };
  const showSection = (i: number) => {
    setSection((i + SECTIONS.length) % SECTIONS.length);
    setCursor(0);
  };

  useInput((input, key) => {
    if (effortStep) {
      if (key.escape) return setEffortStep(undefined);
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(effortStep.options.length - 1, c + 1));
      else if (key.return) chooseEffort(cursor);
      return;
    }
    if (key.escape || input === 'q') return onClose();
    if (key.tab || key.rightArrow) showSection(section + 1);
    else if (key.leftArrow) showSection(section - 1);
    else if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(options.length - 1, c + 1));
    else if (key.return) choose(cursor);
  });
  const wheel = (dir: 1 | -1) => setCursor((c) => Math.max(0, Math.min(options.length - 1, c + dir)));

  if (effortStep) {
    return (
      <Box flexDirection="column" {...(bare ? {} : {borderStyle: 'round' as const, borderColor: 'cyan', paddingX: 1})}>
        <Text bold>Effort for {effortStep.label}</Text>
        <Text dimColor>How hard the model thinks. Changing it mid-conversation discards the prompt cache, so auto only changes it when the cache is cold anyway.</Text>
        <Box flexDirection="column" marginY={1}>
          {effortStep.options.map((o, i) => (
            <Clickable key={o.value} onHover={() => setCursor(i)} onClick={() => chooseEffort(i)}>
              <Text color={i === cursor ? 'cyan' : undefined} wrap="truncate">
                {i === cursor ? '❯ ' : '  '}
                {o.value === (cfg.chatEffort ?? 'auto') ? '● ' : '○ '}
                {o.label}
                {o.hint ? <Text dimColor>  {o.hint}</Text> : null}
              </Text>
            </Clickable>
          ))}
        </Box>
        <Text dimColor>enter choose · esc keep current</Text>
      </Box>
    );
  }

  const start = Math.max(0, Math.min(cursor - Math.floor(MAX_ROWS / 2), options.length - MAX_ROWS));
  const visible = options.slice(start, start + MAX_ROWS);

  return (
    <Box flexDirection="column" {...(bare ? {} : {borderStyle: 'round' as const, borderColor: 'cyan', paddingX: 1})}>
      <TabBar titles={SECTIONS.map((s) => s.title)} active={section} onSelect={showSection} />
      <Text dimColor>{describe(sec.id)}</Text>
      <Box flexDirection="column" marginY={1}>
        {start > 0 && (
          <Clickable onClick={() => wheel(-1)} onWheel={wheel}>
            <Text dimColor>  ↑ more</Text>
          </Clickable>
        )}
        {visible.map((o, i) => {
          const idx = start + i;
          const selected = o.value === current;
          return (
            <Clickable key={o.value} onHover={() => setCursor(idx)} onClick={() => choose(idx)} onWheel={wheel}>
              <Text color={idx === cursor ? 'cyan' : undefined} dimColor={o.disabled} wrap="truncate">
                {idx === cursor ? '❯ ' : '  '}
                {selected ? '● ' : '○ '}
                {o.label}
                {o.hint ? <Text dimColor>  {o.hint}</Text> : null}
              </Text>
            </Clickable>
          );
        })}
        {start + MAX_ROWS < options.length && (
          <Clickable onClick={() => wheel(1)} onWheel={wheel}>
            <Text dimColor>  ↓ more</Text>
          </Clickable>
        )}
      </Box>
      <Text dimColor>click or ←→/tab section · ↑↓ select · enter choose · esc close</Text>
    </Box>
  );
}

